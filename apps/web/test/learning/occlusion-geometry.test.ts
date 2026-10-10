// Image-occlusion editor geometry (§43): masks are normalized boxes on the ORIGINAL image ({x,y,w,h} ∈ [0,1], physical
// axes), independent of the displayed size; drags in any direction, moves and resizes stay inside the image with a
// minimum size; the keyboard alternative moves / resizes with the same rules.
import { describe, expect, it } from 'vitest';
import {
  MIN_MASK,
  applyKey,
  boxDescriptionAr,
  boxFromDrag,
  isValidBox,
  keyAction,
  moveBox,
  newCenteredBox,
  normalizeBox,
  resizeBox,
  toImagePoint,
} from '../../src/features/review/local/occlusion';

const rect = { left: 100, top: 50, width: 400, height: 200 };

describe('pointer → normalized image coordinates', () => {
  it('maps client points into [0,1] of the displayed image, clamped', () => {
    expect(toImagePoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(toImagePoint(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(toImagePoint(700, 400, rect)).toEqual({ x: 1, y: 1 });
    expect(toImagePoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
  });

  it('the same mask is the same normalized box at any display size (zoom independent)', () => {
    const small = { left: 0, top: 0, width: 200, height: 100 };
    const big = { left: 0, top: 0, width: 1600, height: 800 };
    const a = boxFromDrag(toImagePoint(20, 10, small), toImagePoint(80, 40, small));
    const b = boxFromDrag(toImagePoint(160, 80, big), toImagePoint(640, 320, big));
    expect(a).toEqual(b);
    expect(a).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
  });
});

describe('drawing', () => {
  it('a drag in any direction gives the same box', () => {
    const ab = boxFromDrag({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 });
    const ba = boxFromDrag({ x: 0.5, y: 0.6 }, { x: 0.2, y: 0.3 });
    const diag = boxFromDrag({ x: 0.5, y: 0.3 }, { x: 0.2, y: 0.6 });
    expect(ab).toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    expect(ba).toEqual(ab);
    expect(diag).toEqual(ab);
  });
  it('a click (no real drag) draws nothing; a thin drag gets the minimum size', () => {
    expect(boxFromDrag({ x: 0.4, y: 0.4 }, { x: 0.401, y: 0.402 })).toBeNull();
    const thin = boxFromDrag({ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.401 })!;
    expect(thin.h).toBe(MIN_MASK);
    expect(isValidBox(thin)).toBe(true);
  });
});

describe('move and resize stay inside the image', () => {
  const b = { x: 0.7, y: 0.7, w: 0.2, h: 0.2 };
  it('moving past an edge stops at the edge with the size unchanged', () => {
    expect(moveBox(b, 0.5, 0.5)).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(moveBox(b, -2, -2)).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
  });
  it('resizing keeps the opposite edge, a minimum size and the image bounds', () => {
    expect(resizeBox(b, 'se', 0.05, 0.05)).toEqual({ x: 0.7, y: 0.7, w: 0.25, h: 0.25 });
    expect(resizeBox(b, 'se', 1, 1)).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
    expect(resizeBox(b, 'nw', -0.1, -0.1)).toEqual({ x: 0.6, y: 0.6, w: 0.3, h: 0.3 });
    const tiny = resizeBox(b, 'nw', 0.5, 0.5);
    expect(tiny.w).toBe(MIN_MASK);
    expect(tiny.x + tiny.w).toBeCloseTo(0.9, 10); // the right edge did not move
  });
  it('normalizeBox repairs out-of-range input and rounds to 4 decimals', () => {
    expect(normalizeBox({ x: -0.1, y: 0.95, w: 0.123456, h: 0.2 })).toEqual({ x: 0, y: 0.8, w: 0.1235, h: 0.2 });
    expect(isValidBox(normalizeBox({ x: 2, y: 2, w: 2, h: 2 }))).toBe(true);
  });
});

describe('keyboard alternative', () => {
  it('arrows move by 1% (Shift 5%) in PHYSICAL directions — the image is not mirrored in RTL', () => {
    const b = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    expect(applyKey(b, keyAction('ArrowLeft', {}))).toEqual({ x: 0.49, y: 0.5, w: 0.1, h: 0.1 });
    expect(applyKey(b, keyAction('ArrowRight', { shift: true }))).toEqual({ x: 0.55, y: 0.5, w: 0.1, h: 0.1 });
    expect(applyKey(b, keyAction('ArrowDown', {}))).toEqual({ x: 0.5, y: 0.51, w: 0.1, h: 0.1 });
  });
  it('Alt + arrows resize; other keys do nothing', () => {
    const b = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    expect(applyKey(b, keyAction('ArrowRight', { alt: true }))).toEqual({ x: 0.5, y: 0.5, w: 0.11, h: 0.1 });
    expect(applyKey(b, keyAction('ArrowUp', { alt: true }))).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.09 });
    expect(keyAction('a', {})).toBeNull();
  });
  it('a keyboard-added mask is centred and never exactly on top of an existing one', () => {
    const first = newCenteredBox([]);
    const second = newCenteredBox([first]);
    expect(isValidBox(first) && isValidBox(second)).toBe(true);
    expect(second).not.toEqual(first);
  });
  it('describes a mask in words for screen readers', () => {
    expect(boxDescriptionAr({ x: 0.1, y: 0.2, w: 0.3, h: 0.08 })).toBe('من اليسار 10٪، من الأعلى 20٪، العرض 30٪، الارتفاع 8٪');
  });
});
