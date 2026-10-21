// P1-T2 step 2 — ink data v2 (ADR-0004 §2.5, ARCHITECTURE_DELTA §8.2): packed points = base64 of zigzag-delta varints
// using the SAME rounding as the ink engine's roundPoint. The round trip must be lossless for every point the engine
// can write; a point the codec cannot carry exactly keeps the stroke in v1 (never a silent change of the writing).
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_INK_HEADER,
  decodeInkPoints,
  encodeInkPoints,
  inkDataForClient,
  isInkDataV2,
  packInkData,
  parseAcceptInk,
  roundInkPoint,
  toInkV1,
  unpackInkData,
  type InkData,
  type InkPoint,
} from '../src';

/** deterministic pseudo-random numbers (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stroke(n: number, seed: number, arity: 3 | 4 | 6): InkPoint[] {
  const r = rng(seed);
  const pts: InkPoint[] = [];
  let x = r();
  let y = r();
  let t = 0;
  for (let i = 0; i < n; i++) {
    x += (r() - 0.5) * 0.01;
    y += (r() - 0.5) * 0.01;
    t += Math.round(4 + r() * 12);
    const raw: number[] = [x, y, t];
    if (arity >= 4) raw.push(r());
    if (arity === 6) raw.push(Math.round((r() - 0.5) * 120), Math.round((r() - 0.5) * 120));
    pts.push(roundInkPoint(raw as unknown as InkPoint));
  }
  return pts;
}

function inkOf(points: InkPoint[]): InkData {
  return { v: 1, points, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0, y: 0, w: 1, h: 1 }, pressure_available: points[0]!.length > 3, tilt_available: points[0]!.length > 4 };
}

describe('ink codec v2 (packed points)', () => {
  it('round-trips points written through roundPoint losslessly (x, y, t; pressure; tilt), over many random strokes', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const arity of [3, 4, 6] as const) {
        const pts = stroke(1 + (seed % 97) * 3, seed * 7 + arity, arity);
        const packed = encodeInkPoints(pts);
        expect(packed, `seed ${seed} arity ${arity}`).not.toBeNull();
        expect(decodeInkPoints(packed!)).toEqual(pts);
      }
    }
  });

  it('keeps the exact float of every coordinate (Object.is), including negative coordinates past the page edge', () => {
    const pts: InkPoint[] = [roundInkPoint([-0.98765, 1.99999, 0]), roundInkPoint([0.00001, -1, 3, 0.001]), roundInkPoint([2, 0.5, 70000, 1])];
    const back = decodeInkPoints(encodeInkPoints(pts)!);
    back.forEach((p, i) => p.forEach((v, j) => expect(Object.is(v === 0 ? 0 : v, pts[i]![j] === 0 ? 0 : pts[i]![j]!)).toBe(true)));
  });

  it('carries strokes whose points have different lengths (mixed arity) without dropping a channel', () => {
    const pts: InkPoint[] = [roundInkPoint([0.1, 0.1, 0]), roundInkPoint([0.11, 0.1, 8, 0.4]), roundInkPoint([0.12, 0.11, 16, 0.5, 10, -20]), roundInkPoint([0.13, 0.12, 24])];
    expect(decodeInkPoints(encodeInkPoints(pts)!)).toEqual(pts);
  });

  it('refuses (null) points it cannot carry exactly — the stroke then stays v1, nothing is rounded silently', () => {
    expect(encodeInkPoints([[0.123456789, 0.2, 0]])).toBeNull(); // more digits than roundPoint keeps
    expect(encodeInkPoints([[0.1, 0.2, 1.5]])).toBeNull(); // fractional time
    expect(encodeInkPoints([[0.1, 0.2, 0, 0.12345]])).toBeNull(); // pressure finer than 1e-3
    expect(encodeInkPoints([[0.1, 0.2, 0, 0.5, 1.5, 2]])).toBeNull(); // fractional tilt
    expect(encodeInkPoints([[Number.NaN, 0.2, 0]])).toBeNull();
    expect(encodeInkPoints([])).toBeNull();
    const data = inkOf([[0.123456789, 0.2, 0]]);
    expect(packInkData(data)).toBeNull();
    expect(inkDataForClient('ink', data, 2)).toBe(data);
  });

  it('packs InkData into v2 with every other field kept, and unpacks back to the identical v1 object', () => {
    const data: InkData = { ...inkOf(stroke(200, 42, 4)), audio_link: { recording_id: 'REC1', offset_ms: 1200, origin: 'auto' } };
    const v2 = packInkData(data)!;
    expect(v2.v).toBe(2);
    expect(isInkDataV2(v2)).toBe(true);
    expect('points' in v2).toBe(false);
    expect(v2.style).toEqual(data.style);
    expect(v2.audio_link).toEqual(data.audio_link);
    expect(unpackInkData(v2)).toEqual(data);
    expect(toInkV1(v2)).toEqual(data);
    expect(toInkV1(data)).toBe(data);
  });

  it('is much smaller than v1 JSON for a realistic pressure stroke (binary and base64 sizes stated separately)', () => {
    const pts = stroke(120, 9, 4);
    const v1Json = JSON.stringify(pts).length;
    const packed = encodeInkPoints(pts)!;
    const binary = Math.floor((packed.length * 3) / 4);
    expect(binary).toBeLessThan(v1Json / 3);
    expect(packed.length).toBeLessThan(v1Json / 2);
  });

  it('rejects corrupt packed data instead of producing different writing', () => {
    const good = encodeInkPoints(stroke(10, 3, 4))!;
    expect(() => decodeInkPoints('***')).toThrow();
    expect(() => decodeInkPoints(good.slice(0, Math.floor(good.length / 2)))).toThrow();
    expect(() => decodeInkPoints('AA==')).toThrow(); // wrong format byte
  });

  it('negotiates by the accept-ink header: only «2» opts in; old clients (no header) always receive v1', () => {
    expect(ACCEPT_INK_HEADER).toBe('accept-ink');
    expect(parseAcceptInk(undefined)).toBe(1);
    expect(parseAcceptInk('')).toBe(1);
    expect(parseAcceptInk('1')).toBe(1);
    expect(parseAcceptInk('2')).toBe(2);
    expect(parseAcceptInk(' 2 ')).toBe(2);
    expect(parseAcceptInk(['2'])).toBe(2);
    expect(parseAcceptInk('3')).toBe(1);
    const data = inkOf(stroke(30, 5, 3));
    const v2 = packInkData(data)!;
    expect(inkDataForClient('ink', data, 1)).toBe(data);
    expect(inkDataForClient('ink', v2, 1)).toEqual(data);
    expect(inkDataForClient('ink', data, 2)).toEqual(v2);
    // only ink strokes are packed; other kinds pass through untouched
    const shape = { v: 1, shape: 'line', from: [0, 0], to: [1, 1], style: data.style };
    expect(inkDataForClient('shape', shape, 2)).toBe(shape);
  });

  it('roundInkPoint matches the engine rounding: 1e-5 page units, integer ms, pressure 1e-3, integer tilt, clamped to [-1, 2]', () => {
    expect(roundInkPoint([0.123456, 0.654321, 12.6])).toEqual([0.12346, 0.65432, 13]);
    expect(roundInkPoint([5, -7, 0, 0.12345])).toEqual([2, -1, 0, 0.123]);
    expect(roundInkPoint([0.1, 0.2, 0, 0.5, 10.4, -20.6])).toEqual([0.1, 0.2, 0, 0.5, 10, -21]);
    expect(roundInkPoint([0.1, 0.2, 0, 0.5, 10] as unknown as InkPoint)).toEqual([0.1, 0.2, 0, 0.5]);
  });
});
