// Parity N1, G14 — gesture recognisers on a corpus of handwriting shapes (normalized page coordinates of an A4 page,
// sampled like a real pen: a point every ~0.6 pt with a little tremor).
//  * a scribble over writing is recognised and erases only the strokes it covers (≥ 2 strokes, or ≥ 60 % of one);
//  * Arabic س، ش، ممم, Latin m, w and a hand-drawn ECG strip are never taken for a scribble — and so cause NO erasure,
//    on empty paper or next to existing writing; shading inside a drawn outline does not erase the outline;
//  * a closed loop is recognised for circle + hold (an open arc or a back-and-forth line is not);
//  * two- / three-finger double taps → undo / redo, fingers only, never while a pen is down.
import { describe, expect, it } from 'vitest';
import type { NormBox } from '@medlevo/shared';
import { analyseScribble, closedLoop, closedOutline, detectScribble, FingerTapDetector, scribbleTargets, type ScribbleCandidate } from '../../src/features/workspace/ink/gestures';
import type { Vec } from '../../src/features/workspace/ink/math';

const AR = 842 / 595;

/** deterministic tremor */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** samples a parametric path (norm units) every ~`step` of page width, with tremor */
function trace(f: (t: number) => Vec, seed = 1, step = 0.001, jitter = 0.0002): Vec[] {
  const r = rng(seed);
  const out: Vec[] = [];
  let prev = f(0);
  out.push(prev);
  for (let t = 0.0005; t <= 1; t += 0.0005) {
    const p = f(t);
    if (Math.hypot(p[0] - prev[0], (p[1] - prev[1]) * AR) >= step) {
      out.push([p[0] + r() * jitter, p[1] + r() * jitter]);
      prev = p;
    }
  }
  out.push(f(1));
  return out;
}

/** a zig-zag polyline through corner points, traced */
function polyline(corners: Vec[], seed = 1): Vec[] {
  const seg: number[] = [];
  let L = 0;
  for (let i = 1; i < corners.length; i++) {
    const d = Math.hypot(corners[i]![0] - corners[i - 1]![0], (corners[i]![1] - corners[i - 1]![1]) * AR);
    seg.push(d);
    L += d;
  }
  return trace((t) => {
    let d = t * L;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i]! || i === seg.length - 1) {
        const k = seg[i]! > 0 ? Math.min(1, d / seg[i]!) : 0;
        const a = corners[i]!;
        const b = corners[i + 1]!;
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      }
      d -= seg[i]!;
    }
    return corners[corners.length - 1]!;
  }, seed);
}

// ── the corpus ──
/** a scratch-out over a word: 4 back-and-forth swings across x ∈ [0.30, 0.44], drifting down slightly */
function scribbleOverWord(x0 = 0.3, x1 = 0.44, y = 0.2): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= 9; i++) pts.push([i % 2 === 0 ? x0 : x1, y - 0.01 + i * 0.0024]);
  return polyline(pts, 7);
}

/** a tight vertical scratch-out progressing along a word (like a fast «WWWW» with no width) */
function verticalScratch(x0 = 0.3, y0 = 0.19, y1 = 0.215): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= 14; i++) pts.push([x0 + i * 0.0035, i % 2 === 0 ? y0 : y1]);
  return polyline(pts, 3);
}

/** Arabic «س» written right to left: three teeth then the bowl */
function seen(x = 0.6, y = 0.3, teeth = 3, h = 0.009): Vec[] {
  const tw = 0.009;
  return trace((t) => {
    const teethEnd = 0.55;
    if (t < teethEnd) {
      const u = t / teethEnd;
      const px = x - u * teeth * tw;
      const py = y - Math.abs(Math.sin(u * teeth * Math.PI)) * h;
      return [px, py];
    }
    const u = (t - teethEnd) / (1 - teethEnd);
    const cx = x - teeth * tw - 0.016;
    const a = u * Math.PI;
    return [cx + Math.cos(a) * 0.016, y + Math.sin(a) * 0.018];
  }, 11);
}

/** Arabic «ممم»: three small loops along the baseline, right to left, with a final tail */
function meems(x = 0.6, y = 0.4): Vec[] {
  const r = 0.005;
  return trace((t) => {
    const loops = 3;
    const body = 0.85;
    if (t < body) {
      const u = (t / body) * loops;
      const k = Math.floor(Math.min(u, loops - 1e-9));
      const f = u - k;
      const cx = x - k * 0.018 - 0.006;
      if (f < 0.3) return [x - k * 0.018 - (f / 0.3) * 0.006, y];
      const a = ((f - 0.3) / 0.7) * Math.PI * 2;
      return [cx - Math.sin(a) * r, y - r + Math.cos(a) * r];
    }
    const u = (t - body) / (1 - body);
    return [x - loops * 0.018, y + u * 0.02];
  }, 13);
}

/** Latin «m»: down, arch, down, arch, down — left to right */
function latinM(x = 0.2, y = 0.5, h = 0.016): Vec[] {
  const w = 0.012;
  return trace((t) => {
    const s = t * 5;
    const k = Math.floor(Math.min(s, 4.999));
    const f = s - k;
    if (k === 0) return [x, y - h + f * h];
    if (k === 1 || k === 3) {
      const cx = x + (k === 1 ? 0 : w) + w / 2;
      const a = Math.PI - f * Math.PI;
      return [cx + Math.cos(a) * (w / 2), y - h * 0.4 - Math.sin(a) * h * 0.6];
    }
    const lx = x + (k === 2 ? w : 2 * w);
    return [lx, y - h * 0.4 + f * h * 0.4];
  }, 17);
}

/** Latin «w»: down-up-down-up with sharp valleys */
function latinW(x = 0.3, y = 0.5, h = 0.014): Vec[] {
  return polyline(
    [
      [x, y - h],
      [x + 0.006, y],
      [x + 0.012, y - h * 0.7],
      [x + 0.018, y],
      [x + 0.024, y - h],
    ],
    19,
  );
}

/** a hand-drawn ECG strip: 6 beats (P, QRS, T) along x */
function ecg(x0 = 0.08, x1 = 0.92, y = 0.6, beats = 6): Vec[] {
  const span = (x1 - x0) / beats;
  return trace((t) => {
    const u = t * beats;
    const k = Math.floor(Math.min(u, beats - 1e-9));
    const f = u - k;
    const x = x0 + (k + f) * span;
    let dy = 0;
    if (f > 0.1 && f < 0.2) dy = -Math.sin(((f - 0.1) / 0.1) * Math.PI) * 0.006; // P
    else if (f > 0.28 && f < 0.31) dy = ((f - 0.28) / 0.03) * 0.006; // Q
    else if (f >= 0.31 && f < 0.34) dy = 0.006 - ((f - 0.31) / 0.03) * 0.046; // R up
    else if (f >= 0.34 && f < 0.37) dy = -0.04 + ((f - 0.34) / 0.03) * 0.05; // S down
    else if (f >= 0.37 && f < 0.4) dy = 0.01 - ((f - 0.37) / 0.03) * 0.01;
    else if (f > 0.5 && f < 0.68) dy = -Math.sin(((f - 0.5) / 0.18) * Math.PI) * 0.012; // T
    return [x, y + dy];
  }, 23);
}

/** a tachycardic ECG: beats close together (the hardest case) */
function fastEcg(): Vec[] {
  return ecg(0.1, 0.5, 0.7, 9);
}

/** shading inside an outline: dense parallel strokes in one go (anatomy sketch) */
function shading(x0: number, x1: number, y0: number, y1: number): Vec[] {
  const pts: Vec[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) pts.push([i % 2 === 0 ? x0 : x1, y0 + ((y1 - y0) * i) / n]);
  return polyline(pts, 29);
}

/** a circle (closed loop) */
function circle(cx: number, cy: number, r: number, turns = 1.02): Vec[] {
  return trace((t) => [cx + Math.cos(t * turns * 2 * Math.PI) * r, cy + Math.sin(t * turns * 2 * Math.PI) * (r / AR)], 31);
}

const box = (pts: Vec[]): NormBox => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

describe('scribble recognition (shape only)', () => {
  it('recognises a scratch-out drawn across a word, and a tight vertical one', () => {
    expect(analyseScribble(scribbleOverWord(), AR).diag).toMatchObject({ ok: true });
    expect(analyseScribble(verticalScratch(), AR).diag).toMatchObject({ ok: true });
  });

  it('never takes handwriting for a scribble: س، ش، ممم، m، w، an ECG strip (normal and fast)', () => {
    const corpus: Record<string, Vec[]> = {
      'س': seen(),
      'ش': seen(0.5, 0.35, 3, 0.012),
      'سس (two in a row)': [...seen(0.7, 0.3), ...seen(0.62, 0.3)],
      'ممم': meems(),
      m: latinM(),
      w: latinW(),
      'ECG strip': ecg(),
      'ECG, fast rate': fastEcg(),
    };
    for (const [name, pts] of Object.entries(corpus)) {
      const r = analyseScribble(pts, AR);
      expect(r.diag.ok, `${name}: ${JSON.stringify(r.diag)}`).toBe(false);
    }
  });
});

describe('scribble targets (what it erases)', () => {
  const word1 = { id: 'w1', box: { x: 0.31, y: 0.19, w: 0.05, h: 0.022 }, touched: true };
  const word2 = { id: 'w2', box: { x: 0.38, y: 0.19, w: 0.05, h: 0.022 }, touched: true };
  const farLine: ScribbleCandidate = { id: 'far', box: { x: 0.1, y: 0.6, w: 0.5, h: 0.004 }, touched: false };

  it('erases the two words it covers and nothing it does not touch', () => {
    const s = detectScribble(scribbleOverWord(), AR)!;
    expect(s).not.toBeNull();
    expect(scribbleTargets(s, [word1, word2, farLine], AR).sort()).toEqual(['w1', 'w2']);
  });

  it('one stroke: erased only when the scribble covers at least 60 % of its box', () => {
    const s = detectScribble(scribbleOverWord(), AR)!;
    expect(scribbleTargets(s, [word1], AR)).toEqual(['w1']);
    // a long line the scribble crosses at one end is not erased
    const long: ScribbleCandidate = { id: 'long', box: { x: 0.05, y: 0.2, w: 0.6, h: 0.003 }, touched: true };
    expect(scribbleTargets(s, [long], AR)).toEqual([]);
  });

  it('a zig-zag on blank paper beside writing erases nothing (most of it is not over the targets)', () => {
    const s = detectScribble(scribbleOverWord(0.5, 0.64, 0.2), AR)!;
    const edge: ScribbleCandidate = { id: 'edge', box: { x: 0.47, y: 0.19, w: 0.035, h: 0.02 }, touched: true };
    expect(scribbleTargets(s, [edge], AR)).toEqual([]);
  });

  it('shading inside a drawn outline does not erase the outline', () => {
    const outline = circle(0.5, 0.5, 0.12);
    const shade = shading(0.42, 0.54, 0.47, 0.53);
    const s = detectScribble(shade, AR);
    if (s) expect(scribbleTargets(s, [{ id: 'outline', box: box(outline), touched: true }], AR)).toEqual([]);
  });

  // (review) shading or filling INSIDE a small outline drawn before — a cell's nucleus, a hand-drawn check box — is a
  // zig-zag over that outline, but it is drawing, not a scratch-out: the outline stays, and so does the shading
  it('shading inside a small drawn outline (a nucleus, a hand-drawn box) never erases the outline', () => {
    const nucleus = circle(0.5, 0.5, 0.03, 1.02);
    const box2: Vec[] = polyline([
      [0.3, 0.3],
      [0.315, 0.3],
      [0.315, 0.3 + 0.015 / AR],
      [0.3, 0.3 + 0.015 / AR],
      [0.3, 0.3 + 0.0002],
    ]);
    const nucleusOutline = closedOutline(nucleus, AR);
    const boxOutline = closedOutline(box2, AR);
    expect(nucleusOutline).not.toBeNull();
    expect(boxOutline).not.toBeNull();
    // hatching that reaches the outline on every swing (it touches the outline's ink)
    const hatch: Vec[] = [];
    for (let i = 0; i <= 10; i++) {
      const y = 0.5 - (0.03 / AR) * 0.85 + ((0.03 / AR) * 1.7 * i) / 10;
      const half = 0.03 * Math.sqrt(Math.max(0, 1 - ((y - 0.5) / (0.03 / AR)) ** 2));
      hatch.push([i % 2 === 0 ? 0.5 - half : 0.5 + half, y]);
    }
    const s = detectScribble(polyline(hatch, 37), AR);
    expect(s, 'the hatching is a zig-zag').not.toBeNull();
    expect(scribbleTargets(s!, [{ id: 'nucleus', box: box(nucleus), touched: true, outline: nucleusOutline! }], AR)).toEqual([]);
    const fill: Vec[] = [];
    for (let i = 0; i <= 9; i++) fill.push([i % 2 === 0 ? 0.3005 : 0.3145, 0.3 + 0.0004 + ((0.015 / AR - 0.0008) * i) / 9]);
    const f = detectScribble(polyline(fill, 39), AR);
    if (f) expect(scribbleTargets(f, [{ id: 'box', box: box(box2), touched: true, outline: boxOutline! }], AR)).toEqual([]);
  });

  it('a scratch-out that runs over a small loop (a circled word, «٥», «o») still erases it', () => {
    const o = circle(0.36, 0.2, 0.012, 1.02);
    const s = detectScribble(scribbleOverWord(0.3, 0.44, 0.2), AR)!;
    expect(scribbleTargets(s, [{ id: 'o', box: box(o), touched: true, outline: closedOutline(o, AR) ?? undefined }], AR)).toEqual(['o']);
  });

  it('cramped «سسس», small cursive «vvv» and a column of ticks may look like a zig-zag, but erase nothing on empty paper or beside writing', () => {
    // narrow, tall teeth / valleys: the shape alone can pass for a scribble (the corpus above is the normal hand)
    const seens: Vec[] = [];
    for (let i = 0; i <= 9; i++) {
      seens.push([0.6 - i * 0.003, 0.3]);
      if (i < 9) seens.push([0.6 - i * 0.003 - 0.0015, 0.29]);
    }
    const vvv: Vec[] = [[0.3, 0.488]];
    for (let i = 0; i < 6; i++) vvv.push([0.3 + (i + 0.5) * 0.004, 0.5], [0.3 + (i + 1) * 0.004, 0.488]);
    const ticks: Vec[] = [];
    for (let i = 0; i < 5; i++) ticks.push([0.4 + i * 0.012, 0.496], [0.403 + i * 0.012, 0.5], [0.409 + i * 0.012, 0.488]);
    for (const [name, pts, beside] of [
      ['سسس', polyline(seens, 41), { x: 0.5, y: 0.31, w: 0.06, h: 0.012 }],
      ['vvv', polyline(vvv, 43), { x: 0.2, y: 0.505, w: 0.09, h: 0.01 }],
      ['ticks', polyline(ticks, 47), { x: 0.47, y: 0.47, w: 0.1, h: 0.012 }],
    ] as Array<[string, Vec[], NormBox]>) {
      const s = detectScribble(pts, AR);
      if (!s) continue;
      expect(scribbleTargets(s, [], AR), `${name} on empty paper`).toEqual([]);
      expect(scribbleTargets(s, [{ id: 'near', box: beside, touched: true }], AR), `${name} beside writing`).toEqual([]);
    }
  });

  it('handwriting written over existing writing never erases it (the shapes are not scribbles)', () => {
    for (const pts of [seen(0.34, 0.205), meems(0.36, 0.21), latinM(0.31, 0.21), latinW(0.32, 0.21), ecg(0.25, 0.5, 0.2, 3)]) {
      expect(detectScribble(pts, AR)).toBeNull();
    }
  });
});

describe('closed loop (circle + hold)', () => {
  it('recognises a circle and an oval drawn round once', () => {
    expect(closedLoop(circle(0.5, 0.5, 0.06), AR)).not.toBeNull();
    expect(closedLoop(trace((t) => [0.4 + Math.cos(t * 2.05 * Math.PI) * 0.1, 0.3 + Math.sin(t * 2.05 * Math.PI) * 0.03], 5), AR)).not.toBeNull();
  });

  it('rejects an open arc, a scribble, a straight line and a tiny dot-loop', () => {
    expect(closedLoop(circle(0.5, 0.5, 0.06, 0.6), AR)).toBeNull();
    expect(closedLoop(scribbleOverWord(), AR)).toBeNull();
    expect(closedLoop(polyline([[0.1, 0.1], [0.6, 0.1]]), AR)).toBeNull();
    expect(closedLoop(circle(0.5, 0.5, 0.004), AR)).toBeNull();
  });
});

describe('two- and three-finger double tap', () => {
  function run(events: Array<[string, number, string, number, number?, number?]>) {
    const got: number[] = [];
    const d = new FingerTapDetector((n) => got.push(n));
    for (const [kind, id, type, t, x = 100, y = 100] of events) {
      if (kind === 'down') d.down(id, type, x, y, t);
      else if (kind === 'move') d.move(id, x, y);
      else if (kind === 'up') d.up(id, type, t);
      else d.cancel(id, type);
    }
    return got;
  }
  const tap = (ids: number[], t0: number): Array<[string, number, string, number]> => [...ids.map((id): [string, number, string, number] => ['down', id, 'touch', t0]), ...ids.map((id): [string, number, string, number] => ['up', id, 'touch', t0 + 90])];

  it('two fingers, twice → undo; three fingers, twice → redo', () => {
    expect(run([...tap([1, 2], 0), ...tap([3, 4], 250)])).toEqual([2]);
    expect(run([...tap([1, 2, 3], 0), ...tap([4, 5, 6], 250)])).toEqual([3]);
  });

  it('ignores one finger, slow taps, taps far apart in time, moving fingers and cancelled pointers', () => {
    expect(run([...tap([1], 0), ...tap([2], 200)])).toEqual([]);
    expect(run([['down', 1, 'touch', 0], ['down', 2, 'touch', 0], ['up', 1, 'touch', 500], ['up', 2, 'touch', 500], ...tap([3, 4], 600)])).toEqual([]);
    expect(run([...tap([1, 2], 0), ...tap([3, 4], 900)])).toEqual([]);
    expect(run([['down', 1, 'touch', 0], ['down', 2, 'touch', 0], ['move', 2, 'touch', 30, 160, 100], ['up', 1, 'touch', 90], ['up', 2, 'touch', 90], ...tap([3, 4], 250)])).toEqual([]);
    expect(run([['down', 1, 'touch', 0], ['down', 2, 'touch', 0], ['cancel', 2, 'touch', 40], ['up', 1, 'touch', 90], ...tap([3, 4], 250)])).toEqual([]);
  });

  it('never fires while a pen is on the screen; the mouse never counts', () => {
    expect(run([['down', 9, 'pen', 0], ...tap([1, 2], 10), ...tap([3, 4], 250), ['up', 9, 'pen', 400]])).toEqual([]);
    expect(run([['down', 1, 'mouse', 0], ['up', 1, 'mouse', 50], ['down', 2, 'mouse', 100], ['up', 2, 'mouse', 150]])).toEqual([]);
  });
});
