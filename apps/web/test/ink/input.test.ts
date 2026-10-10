import { describe, expect, it } from 'vitest';
import { classifyPointerDown, MIN_STEP, StrokeCapture, type PointerLike } from '../../src/features/workspace/ink/input';
import { buildCapabilityReport, detectApiSupport, EMPTY_OBSERVATIONS, tiltOf, type ApiSupport } from '../../src/features/workspace/ink/capabilities';

const base: PointerLike = { pointerType: 'pen', button: 0, buttons: 1, width: 1, height: 1, isPrimary: true };
const ctx = { penOnly: true, strokeActive: false, sincePenUp: Infinity };

describe('pointer policy (palm / finger rejection heuristic)', () => {
  it('pen and mouse write; a finger does not write in pen-only mode (it scrolls)', () => {
    expect(classifyPointerDown(base, ctx)).toBe('write');
    expect(classifyPointerDown({ ...base, pointerType: 'mouse' }, ctx)).toBe('write');
    expect(classifyPointerDown({ ...base, pointerType: 'touch', width: 12, height: 12 }, ctx)).toBe('ignore_touch_pen_only');
  });

  it('with pen-only off, a fingertip writes but a palm-sized contact does not', () => {
    const finger = { ...base, pointerType: 'touch', width: 14, height: 16 };
    expect(classifyPointerDown(finger, { ...ctx, penOnly: false })).toBe('write');
    expect(classifyPointerDown({ ...finger, width: 80, height: 60 }, { ...ctx, penOnly: false })).toBe('ignore_palm');
  });

  it('a touch right after the pen lifted is treated as the resting hand', () => {
    expect(classifyPointerDown({ ...base, pointerType: 'touch', width: 10, height: 10 }, { ...ctx, penOnly: false, sincePenUp: 120 })).toBe('ignore_palm');
  });

  it('no second pointer while a stroke is in progress; secondary buttons never write', () => {
    expect(classifyPointerDown(base, { ...ctx, strokeActive: true })).toBe('ignore_secondary');
    expect(classifyPointerDown({ ...base, pointerType: 'mouse', button: 2 }, ctx)).toBe('ignore_button');
  });

  it("the pen's eraser end erases (W3C Pointer Events: button 5 / buttons 32)", () => {
    expect(classifyPointerDown({ ...base, button: 5, buttons: 32 }, ctx)).toBe('erase_with_pen_eraser');
  });
});

describe('stroke capture', () => {
  const toNorm = (x: number, y: number): [number, number] => [x / 1000, y / 1000];
  const ev = (x: number, y: number, t: number, extra: Record<string, number> = {}) => ({ clientX: x, clientY: y, timeStamp: t, pressure: 0.5, pointerType: 'mouse', ...extra });

  it('mouse: no pressure, no tilt → points stored as [x, y, t] and flags false', () => {
    const c = new StrokeCapture('mouse', toNorm, 1, ev(100, 100, 1000));
    c.add(ev(110, 100, 1008));
    c.end(ev(120, 100, 1016));
    expect(c.pressureAvailable).toBe(false);
    expect(c.tiltAvailable).toBe(false);
    expect(c.finalPoints()).toEqual([
      [0.1, 0.1, 0],
      [0.11, 0.1, 8],
      [0.12, 0.1, 16],
    ]);
  });

  it('pen with real pressure and tilt → full points', () => {
    const c = new StrokeCapture('pen', toNorm, 1, ev(100, 100, 0, { pressure: 0.2, tiltX: 30, tiltY: -10 }));
    c.add(ev(110, 100, 8, { pressure: 0.6, tiltX: 31, tiltY: -9 }));
    expect(c.pressureAvailable).toBe(true);
    expect(c.tiltAvailable).toBe(true);
    expect(c.finalPoints()[1]).toEqual([0.11, 0.1, 8, 0.6, 31, -9]);
  });

  it('drops samples closer than the minimum step, but always keeps the lift point', () => {
    const c = new StrokeCapture('mouse', toNorm, 1, ev(100, 100, 0));
    expect(c.add(ev(100 + MIN_STEP * 1000 * 0.3, 100, 2))).toBe(false);
    c.end(ev(100 + MIN_STEP * 1000 * 0.6, 100, 4));
    expect(c.points).toHaveLength(2);
  });

  it('tilt is derived from altitude/azimuth when tiltX/tiltY are not reported', () => {
    const [tx, ty] = tiltOf({ tiltX: 0, tiltY: 0, altitudeAngle: Math.PI / 4, azimuthAngle: 0 });
    expect(tx).toBeCloseTo(45, 6);
    expect(ty).toBeCloseTo(0, 6);
    expect(tiltOf({ tiltX: 0, tiltY: 0, altitudeAngle: Math.PI / 2, azimuthAngle: 0 })).toEqual([0, 0]); // perpendicular / not reported
  });
});

describe('capability report is honest (AC-28)', () => {
  const api: ApiSupport = { pointerEvents: true, coalesced: true, predicted: true, altitude: true, touchType: false, indexedDB: true, anyFinePointer: true, anyHover: true };
  const byKey = (rows: ReturnType<typeof buildCapabilityReport>) => Object.fromEntries(rows.map((r) => [r.key, r]));

  it('before any pen input nothing hardware-related is claimed', () => {
    const r = byKey(buildCapabilityReport(api, EMPTY_OBSERVATIONS));
    expect(r.pressure!.state).toBe('not_observed');
    expect(r.tilt!.state).toBe('not_observed');
    expect(r.hover!.state).toBe('not_observed');
  });

  it('mouse input never validates pen capabilities', () => {
    const r = byKey(buildCapabilityReport(api, { ...EMPTY_OBSERVATIONS, mouseSeen: true, maxCoalesced: 1 }));
    expect(r.pressure!.state).toBe('not_observed');
    expect(r.palm!.state).toBe('heuristic');
  });

  it('a pen without pressure variation is reported as not reporting pressure', () => {
    const r = byKey(buildCapabilityReport(api, { ...EMPTY_OBSERVATIONS, penSeen: true }));
    expect(r.pressure!.state).toBe('not_reported');
    expect(r.tilt!.state).toBe('not_reported');
  });

  it('observed pressure / tilt / hover / coalesced are reported as supported', () => {
    const r = byKey(buildCapabilityReport(api, { ...EMPTY_OBSERVATIONS, penSeen: true, pressureVaried: true, pressureFrom: 'pen', tiltSeen: true, hoverSeen: true, maxCoalesced: 4, predictedSeen: true, desynchronized: true }));
    for (const k of ['pressure', 'tilt', 'hover', 'coalesced', 'predicted', 'desync']) expect(r[k]!.state).toBe('supported');
  });

  it('native-only features are never shown as implemented on the web', () => {
    const r = byKey(buildCapabilityReport(api, { ...EMPTY_OBSERVATIONS, penSeen: true, pressureVaried: true }));
    for (const k of ['double_tap', 'squeeze', 'pencilkit', 'scribble']) expect(r[k]!.state).toBe('requires_native');
    // (track F4) recognition is built; without a vision provider on the server it needs configuration
    expect(r.recognition!.state).toBe('requires_configuration');
    expect(byKey(buildCapabilityReport(api, EMPTY_OBSERVATIONS, { recognitionAvailable: true })).recognition!.state).toBe('supported');
  });

  it('missing APIs are reported as not available in this browser', () => {
    const r = byKey(buildCapabilityReport({ ...api, coalesced: false, predicted: false, indexedDB: false }, EMPTY_OBSERVATIONS));
    expect(r.coalesced!.state).toBe('not_reported');
    expect(r.predicted!.state).toBe('not_reported');
    expect(r.offline!.state).toBe('not_reported');
  });

  it('feature detection runs without throwing in jsdom', () => {
    const s = detectApiSupport();
    expect(typeof s.coalesced).toBe('boolean');
  });
});
