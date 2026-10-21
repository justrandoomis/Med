// Parity N1 wave 2 — the pure logic of the new writing aids (test-first for each module):
//  * G04 dashes / dots cut by arc length in page units; G06 pencil = pressure → width AND opacity, grain, points only;
//  * G20 shapes drawn from the shared geometry (fill, solid activation head, inhibition bar, dashed conversion);
//    a polygon / curved arrow moves and turns with its corners and control point;
//  * G09 the zoom window geometry: right to left for Arabic (advance to the LEFT, wrap to the next line's right side);
//  * G10 insert space (only the items after the line, one step), straighten (rotation only), word reflow (only when the
//    recognition read the same number of words; words translate as a whole);
//  * G11 the neat copy is derived: the stored strokes are never changed;
//  * G08 the ruler (projection, 15° settle, marks) and the educational measurement (scale bar, length, angle, label);
//  * G22 snapping lines from items, the paper grid and processed regions;
//  * G21 connectors re-route with their shapes; «add a connected shape»; auto layout; the relation check;
//  * G07 eyedropper colour compositing and the capability row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INK_SETTINGS, inkSettingsSchema, newId, richTextFromPlain, shapeSidePoint, type AnnotationAnchor, type InkData, type InkPoint, type InkStyle, type ShapeData } from '@medlevo/shared';
import { buildCapabilityReport, detectApiSupport, EMPTY_OBSERVATIONS } from '../../src/features/workspace/ink/capabilities';
import { ATTACH_GAP, attachPoint, autoLayoutPlan, checkRelation, connectedShapePlan, connectorSentence, followConnectors, isConnector, nearestSide, attachTarget, rerouteConnector } from '../../src/features/workspace/ink/connectors';
import { composite, eyedropperPath, toHex } from '../../src/features/workspace/ink/eyedropper';
import { baselineAngle, insertSpacePlan, reflowPlan, straightenPlan, writtenLines } from '../../src/features/workspace/ink/handwritingLayout';
import { angleBetween, calibrate, EDUCATIONAL_LABEL_AR, formatReal, frameAt, frameLength, loadCalibration, realLength, saveCalibration } from '../../src/features/workspace/ink/measure';
import { itemBBox, makeInkItem, makeShapeItem, transformItem, type InkItem, type InkItemOf } from '../../src/features/workspace/ink/model';
import { neatCopyItems, NEAT_COPY_LABEL_AR } from '../../src/features/workspace/ink/neatCopy';
import { dashPattern, dashPieces, grainAlphas, pencilAlpha, pencilWidthFactor } from '../../src/features/workspace/ink/pencil';
import { drawItem, pathsForTest } from '../../src/features/workspace/ink/render';
import { placeRuler, projectOnEdge, rotateRuler, rulerAngleDeg, rulerEdge, rulerMarks, snapPointsToRuler, startsAtEdge, twoFingerRuler, PT_PER_CM } from '../../src/features/workspace/ink/ruler';
import { buildSnapTargets, nearestLine, paperPitch, snapMove, snapPoint } from '../../src/features/workspace/ink/snap';
import { advanceBox, boxAt, lineStartBox, magnification, nextLineBox, pageToStrip, shouldAdvance, stripToPage, zoomDirection } from '../../src/features/workspace/ink/zoomGeometry';
import { stubContext } from './n1-helpers';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: 'P', page_index: 0, space: 'page_norm' };
const AR = 800 / 600;
const K = 'page:P';
let zc = 1;
function inkItem(points: InkPoint[], style: Partial<InkStyle> = {}, pressure = false): InkItemOf<InkData> {
  return makeInkItem({ id: newId(), anchor, now: 1, z: zc++, style: { tool: 'pen', color: 'ink-black', width: 0.003, ...style }, points, pressureAvailable: pressure, tiltAvailable: false, pointerType: 'pen' });
}
function line(x0: number, x1: number, y: number, slope = 0, n = 8): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    out.push([x, y + slope * (x - x0), i * 10] as InkPoint);
  }
  return out;
}
/** a short «word» of handwriting: a zigzag between y and y + h */
function word(x0: number, w: number, y: number, h = 0.02): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i <= 6; i++) out.push([x0 + (w * i) / 6, y + (i % 2 ? h : 0), i * 10] as InkPoint);
  return out;
}
function shape(kind: ShapeData['shape'], from: [number, number], to: [number, number], extra: Partial<ShapeData> = {}, id = newId()): InkItemOf<ShapeData> {
  return makeShapeItem({ id, anchor, now: 1, z: zc++, shape: kind, from, to, style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra });
}

class FakePath {
  pts: Array<[number, number]> = [];
  moves = 0;
  closed = 0;
  moveTo(x: number, y: number) {
    this.moves++;
    this.pts.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.pts.push([x, y]);
  }
  quadraticCurveTo(_cx: number, _cy: number, x: number, y: number) {
    this.pts.push([x, y]);
  }
  bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number) {
    this.pts.push([x, y]);
  }
  arc(x: number, y: number) {
    this.pts.push([x, y]);
  }
  ellipse(x: number, y: number) {
    this.pts.push([x, y]);
  }
  closePath() {
    this.closed++;
  }
}

describe('G04 dashes and dots (page units, by arc length)', () => {
  it('the pattern scales with the width and never vanishes; pieces follow the line', () => {
    const [on, off] = dashPattern('dash', 2);
    expect(on).toBeCloseTo(8, 6);
    expect(off).toBeCloseTo(5.2, 6);
    const [don, doff] = dashPattern('dot', 2);
    expect(don).toBeLessThan(0.1);
    expect(doff).toBeGreaterThan(1.5);
    // a 100-unit line with an 8 / 5.2 pattern: 8 pieces, the first starting at the line's start
    const pieces = dashPieces(
      [
        [0, 0],
        [100, 0],
      ],
      [8, 5.2],
    );
    expect(pieces.length).toBe(8);
    expect(pieces[0]!.a).toEqual([0, 0]);
    expect(pieces[0]!.b[0]).toBeCloseTo(8, 6);
    // the pattern continues across a bend (the phase is carried by arc length)
    const bent = dashPieces(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [8, 5.2],
    );
    const total = bent.reduce((n, p) => n + Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]), 0);
    expect(total).toBeCloseTo(8 + (20 - 13.2), 6);
  });

  describe('drawn', () => {
    beforeEach(() => vi.stubGlobal('Path2D', FakePath));
    afterEach(() => vi.unstubAllGlobals());
    it('a dashed stroke is cut into separate pieces; an old stroke draws as one line', () => {
      const plain = pathsForTest(inkItem(line(0.1, 0.6, 0.3)), 600, 800)!;
      expect((plain.path as unknown as FakePath).moves).toBe(1);
      const dashed = pathsForTest(inkItem(line(0.1, 0.6, 0.3), { dash: 'dash' }), 600, 800)!;
      expect((dashed.path as unknown as FakePath).moves).toBeGreaterThan(5);
      const dotted = pathsForTest(inkItem(line(0.1, 0.6, 0.3), { dash: 'dot' }), 600, 800)!;
      expect((dotted.path as unknown as FakePath).moves).toBeGreaterThan((dashed.path as unknown as FakePath).moves);
    });
  });
});

describe('G06 the pencil (points-only InkData, pressure → width and opacity, grain)', () => {
  it('light pressure is thinner AND lighter; the grain tile is deterministic', () => {
    expect(pencilWidthFactor(0.1)).toBeLessThan(pencilWidthFactor(0.9));
    expect(pencilAlpha(0.1)).toBeLessThan(pencilAlpha(0.9));
    expect(pencilWidthFactor(0.5)).toBeCloseTo(1, 6);
    expect(Array.from(grainAlphas(16, 7))).toEqual(Array.from(grainAlphas(16, 7)));
    expect(Array.from(grainAlphas(16, 7))).not.toEqual(Array.from(grainAlphas(16, 8)));
  });
  describe('drawn', () => {
    beforeEach(() => vi.stubGlobal('Path2D', FakePath));
    afterEach(() => vi.unstubAllGlobals());
    it('a pencil stroke with pressure draws buckets of different opacity; without pressure one opacity', () => {
      const pts: InkPoint[] = [];
      for (let i = 0; i <= 20; i++) pts.push([0.1 + i * 0.02, 0.3, i * 10, 0.1 + (i % 5) * 0.2] as InkPoint);
      const pencil = inkItem(pts, { texture: 'graphite' }, true);
      // stored as a pen (an older app draws a pen line) with the texture: points only, nothing else
      expect(pencil.data.style.tool).toBe('pen');
      expect(Object.keys(pencil.data).sort()).toEqual(['bbox', 'points', 'pressure_available', 'style', 'tilt_available', 'v']);
      const p = pathsForTest(pencil, 600, 800)!;
      expect(p.graphite).toBe(true);
      const alphas = new Set(p.buckets!.map((b) => b.alpha));
      expect(alphas.size).toBeGreaterThan(1);
      const flat = pathsForTest(inkItem(pts, { texture: 'graphite' }, false), 600, 800)!;
      expect(flat.graphite).toBe(true);
      expect(flat.alpha).toBeGreaterThan(0.5);
      // drawn with the per-bucket opacity
      const ctx = stubContext();
      const seen: number[] = [];
      ctx.stroke = (() => seen.push(ctx.globalAlpha)) as never;
      drawItem(ctx, pencil, { W: 600, H: 800, tone: 'light', css: null });
      expect(new Set(seen).size).toBeGreaterThan(1);
    });
  });
});

describe('G20 shapes from the shared geometry', () => {
  beforeEach(() => vi.stubGlobal('Path2D', FakePath));
  afterEach(() => vi.unstubAllGlobals());
  it('a filled rounded rectangle has a fill path; an activation arrow a solid head; inhibition a bar; conversion dashed', () => {
    const rect = pathsForTest(shape('rect', [0.1, 0.1], [0.3, 0.2], { fill: 'hl-yellow', corner: 0.02 }), 600, 800)!;
    expect(rect.fill).toBeTruthy();
    const plain = pathsForTest(shape('rect', [0.1, 0.1], [0.3, 0.2]), 600, 800)!;
    expect(plain.fill ?? null).toBeNull();
    const act = pathsForTest(shape('arrow', [0.1, 0.5], [0.5, 0.5], { head: 'activation' }), 600, 800)!;
    expect(act.solid).toBeTruthy();
    const inh = pathsForTest(shape('arrow', [0.1, 0.5], [0.5, 0.5], { head: 'inhibition' }), 600, 800)!;
    expect(inh.solid ?? null).toBeNull();
    // the bar ⊣ is perpendicular to the shaft at its end: two points with the same x (the end), different y
    const bar = (inh.path as unknown as FakePath).pts.filter((q) => Math.abs(q[0] - 300) < 1e-6);
    expect(bar.length).toBeGreaterThanOrEqual(2);
    const conv = pathsForTest(shape('arrow', [0.1, 0.5], [0.5, 0.5], { head: 'conversion' }), 600, 800)!;
    expect((conv.path as unknown as FakePath).moves).toBeGreaterThan(3);
    const tri = pathsForTest(shape('triangle', [0.1, 0.1], [0.3, 0.3]), 600, 800)!;
    expect((tri.path as unknown as FakePath).closed).toBeGreaterThanOrEqual(1);
  });
  it('a polygon and a curved arrow move and turn with their corners and control point', () => {
    const poly = shape('polygon', [0.1, 0.1], [0.3, 0.3], {
      points: [
        [0.1, 0.1],
        [0.3, 0.1],
        [0.2, 0.3],
      ],
    });
    const moved = transformItem(poly, [1, 0, 0, 1, 0.1, 0], AR, 2) as InkItemOf<ShapeData>;
    expect(moved.data.points![0]![0]).toBeCloseTo(0.2, 5);
    expect(moved.data.points![2]![1]).toBeCloseTo(0.3, 5);
    const curve = shape('curved_arrow', [0.1, 0.5], [0.5, 0.5], { control: [0.3, 0.4] });
    const mc = transformItem(curve, [1, 0, 0, 1, 0, 0.1 * AR], AR, 2) as InkItemOf<ShapeData>;
    expect(mc.data.control![1]).toBeCloseTo(0.5, 5);
    // the label scale follows a uniform resize
    const lab = shape('rect', [0.1, 0.1], [0.3, 0.2], { label: richTextFromPlain('GLUT4'), label_scale: 0.02 });
    const big = transformItem(lab, [2, 0, 0, 2, 0, 0], AR, 2) as InkItemOf<ShapeData>;
    expect(big.data.label_scale).toBeCloseTo(0.04, 5);
  });
});

describe('G09 the zoom window geometry', () => {
  const z = { margin_start: 0.06, margin_end: 0.06, line_gap: 0.012 };
  it('auto writes right to left unless the page is English; the owner can choose', () => {
    expect(zoomDirection('auto', 'ar')).toBe('rtl');
    expect(zoomDirection('auto', null)).toBe('rtl');
    expect(zoomDirection('auto', 'en')).toBe('ltr');
    expect(zoomDirection('ltr', 'ar')).toBe('ltr');
    expect(zoomDirection('rtl', 'en')).toBe('rtl');
  });
  it('RTL: a line starts at the right margin and advances to the LEFT; past the left margin it wraps to the next line', () => {
    const size = { w: 0.3, h: 0.03 };
    const first = lineStartBox(0.2, size, 'rtl', z);
    expect(first.x + first.w).toBeCloseTo(0.94, 6);
    const a = advanceBox(first, 'rtl', z);
    expect(a.wrapped).toBe(false);
    expect(a.box.x).toBeLessThan(first.x);
    let b = a.box;
    let wrapped = false;
    for (let i = 0; i < 10 && !wrapped; i++) {
      const n = advanceBox(b, 'rtl', z);
      wrapped = n.wrapped;
      if (!wrapped) expect(n.box.x).toBeGreaterThanOrEqual(0.06 - 1e-9);
      b = n.box;
    }
    expect(wrapped).toBe(true);
    expect(b.y).toBeCloseTo(0.2 + 0.03 + 0.012, 6);
    expect(b.x + b.w).toBeCloseTo(0.94, 6); // back at the right side
    // LTR is the mirror
    const l = lineStartBox(0.2, size, 'ltr', z);
    expect(l.x).toBeCloseTo(0.06, 6);
    expect(advanceBox(l, 'ltr', z).box.x).toBeGreaterThan(l.x);
    expect(nextLineBox(l, 'ltr', z).x).toBeCloseTo(0.06, 6);
  });
  it('a tap places the box with its start side at the tap; strip ↔ page mapping is exact; advance after the far third', () => {
    const b = boxAt([0.7, 0.5], { w: 0.3, h: 0.04 }, 'rtl', z);
    expect(b.x + b.w).toBeCloseTo(0.7, 6);
    expect(b.y).toBeCloseTo(0.48, 6);
    const p = stripToPage([0.25, 0.5], b);
    const back = pageToStrip(p, b);
    expect(back[0]).toBeCloseTo(0.25, 9);
    expect(back[1]).toBeCloseTo(0.5, 9);
    expect(shouldAdvance({ x0: 0.2, x1: 0.9 }, 'rtl')).toBe(true);
    expect(shouldAdvance({ x0: 0.5, x1: 0.9 }, 'rtl')).toBe(false);
    expect(shouldAdvance({ x0: 0.1, x1: 0.7 }, 'ltr')).toBe(true);
    expect(magnification({ x: 0, y: 0, w: 0.3, h: 0.04 }, 160, 800)).toBeCloseTo(5, 6);
  });
});

describe('G10 insert space, straighten, word reflow', () => {
  it('insert space moves only the movable items below the line, by the drag, in one plan; crossing items stay', () => {
    const above = inkItem(line(0.1, 0.5, 0.1));
    const below = inkItem(line(0.1, 0.5, 0.5));
    const crossing = inkItem([
      [0.2, 0.25, 0],
      [0.2, 0.35, 10],
    ] as InkPoint[]);
    const locked = { ...inkItem(line(0.1, 0.5, 0.6)), locked: true };
    const plan = insertSpacePlan([above, below, crossing, locked], { axis: 'y', at: 0.3, delta: 0.05, targetKey: K, ar: AR, now: 5, movable: (it) => !it.locked });
    expect(plan.changes.map((c) => c.id)).toEqual([below.id]);
    expect(plan.crossing).toBe(1);
    const after = plan.changes[0]!.after as InkItemOf<InkData>;
    expect(after.data.points[0]![1]).toBeCloseTo(0.55, 5);
    expect(after.data.points[0]![0]).toBeCloseTo(0.1, 5);
    // upward never (it would close space onto writing); x: Arabic pushes the rest of the line LEFT
    expect(insertSpacePlan([below], { axis: 'y', at: 0.3, delta: -0.05, targetKey: K, ar: AR, now: 5, movable: () => true }).changes).toEqual([]);
    const leftWord = inkItem(word(0.1, 0.1, 0.5));
    const rightWord = inkItem(word(0.6, 0.1, 0.5));
    const px = insertSpacePlan([leftWord, rightWord], { axis: 'x', at: 0.4, delta: -0.05, targetKey: K, ar: AR, now: 5, movable: () => true });
    expect(px.changes.map((c) => c.id)).toEqual([leftWord.id]);
  });
  it('straighten turns a tilted line level (rotation only: every point keeps its distance to the others)', () => {
    const tilted = inkItem(line(0.2, 0.6, 0.4, 0.1, 20));
    expect(Math.abs(baselineAngle([tilted], AR))).toBeGreaterThan(0.05);
    const plan = straightenPlan([tilted], { targetKey: K, ar: AR, now: 5, movable: () => true });
    expect(plan.lines).toBe(1);
    const after = plan.changes[0]!.after as InkItemOf<InkData>;
    expect(Math.abs(baselineAngle([after], AR))).toBeLessThan(0.002);
    const d0 = Math.hypot(tilted.data.points[0]![0] - tilted.data.points[20]![0], (tilted.data.points[0]![1] - tilted.data.points[20]![1]) * AR);
    const d1 = Math.hypot(after.data.points[0]![0] - after.data.points[20]![0], (after.data.points[0]![1] - after.data.points[20]![1]) * AR);
    expect(d1).toBeCloseTo(d0, 4);
    // a level line is left alone
    expect(straightenPlan([inkItem(line(0.2, 0.6, 0.4))], { targetKey: K, ar: AR, now: 5, movable: () => true }).lines).toBe(0);
  });
  it('lines and words of Arabic writing: right to left, a narrow gap stays inside a word', () => {
    const w1a = inkItem(word(0.7, 0.05, 0.3));
    const w1b = inkItem(word(0.755, 0.04, 0.3)); // the gap after «ر»: narrow, same word
    const w2 = inkItem(word(0.5, 0.1, 0.3));
    const lines = writtenLines([w2, w1a, w1b], AR, 'rtl');
    expect(lines.length).toBe(1);
    expect(lines[0]!.words.length).toBe(2);
    expect(lines[0]!.words[0]!.ids.sort()).toEqual([w1a.id, w1b.id].sort()); // the first word read is the right one
  });
  it('reflow (phase 2) refuses when the recognition read a different number of words; otherwise words only translate', () => {
    const ws = [inkItem(word(0.8, 0.08, 0.3)), inkItem(word(0.6, 0.08, 0.3)), inkItem(word(0.4, 0.08, 0.3)), inkItem(word(0.2, 0.08, 0.3))];
    const opts = { width: 0.2, dir: 'rtl' as const, targetKey: K, ar: AR, now: 5, movable: () => true };
    const bad = reflowPlan(ws, [{ words: [{ text: 'الضغط' }, { text: 'الشرياني' }] }], opts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason_ar).toContain('لم يتغير شيء');
    expect(reflowPlan(ws, [], opts).ok).toBe(false);
    const ok = reflowPlan(ws, [{ words: [{ text: 'ارتفاع' }, { text: 'ضغط' }, { text: 'الدم' }, { text: 'الشرياني' }] }], opts);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.words).toBe(4);
    expect(ok.lines).toBeGreaterThan(1);
    for (const c of ok.changes) {
      const b = c.before as InkItemOf<InkData>;
      const a = c.after as InkItemOf<InkData>;
      // translation only: every point moved by the same offset
      const dx = a.data.points[0]![0] - b.data.points[0]![0];
      const dy = a.data.points[0]![1] - b.data.points[0]![1];
      a.data.points.forEach((p, i) => {
        expect(p[0] - b.data.points[i]![0]).toBeCloseTo(dx, 4);
        expect(p[1] - b.data.points[i]![1]).toBeCloseTo(dy, 4);
      });
    }
    // the first word (rightmost) stays at the right edge of the area
    const first = ok.changes.find((c) => c.id === ws[0]!.id);
    if (first) expect(itemBBox(first.after!, AR).x + itemBBox(first.after!, AR).w).toBeCloseTo(0.88, 2);
  });
});

describe('G11 the neat copy is derived', () => {
  it('returns new objects; the stored strokes are byte-identical afterwards', () => {
    const items: InkItem[] = [inkItem(line(0.2, 0.6, 0.3, 0.08, 16)), inkItem(line(0.2, 0.6, 0.5, -0.05, 16), { width: 0.004 }), shape('rect', [0.1, 0.7], [0.3, 0.8])];
    const before = JSON.stringify(items);
    const neat = neatCopyItems(items, AR, 'rtl');
    expect(JSON.stringify(items)).toBe(before);
    expect(neat[0]).not.toBe(items[0]);
    expect(neat[2]).toBe(items[2]); // shapes untouched
    expect(Math.abs(baselineAngle([neat[0] as InkItemOf<InkData>], AR))).toBeLessThan(0.01);
    expect((neat[1] as InkItemOf<InkData>).data.style.width).toBe(0.004);
    expect(NEAT_COPY_LABEL_AR).toContain('لم يتغير');
  });
});

describe('G08 the ruler and the educational measurement', () => {
  it('a stroke along the edge becomes straight on it; 15° settle; marks every half centimetre', () => {
    const r = placeRuler(K, [0.5, 0.5], 0);
    const edge = rulerEdge(r, AR);
    expect(edge.a[1]).toBeCloseTo(0.5 * AR - 0.025, 6);
    const wobbly = [0, 1, 2, 3, 4].map((i) => [0.2 + i * 0.1, (edge.a[1] + (i % 2 ? 0.004 : -0.003)) / AR, i * 10, 0.5] as InkPoint);
    expect(startsAtEdge([wobbly[0]![0], wobbly[0]![1] * AR], r, AR, 0.02)).toBe(true);
    const straight = snapPointsToRuler(wobbly, r, AR);
    for (const p of straight) expect(p[1] * AR).toBeCloseTo(edge.a[1], 9);
    expect(straight[2]![2]).toBe(20); // time and pressure kept
    expect(straight[2]![3]).toBe(0.5);
    expect(rulerAngleDeg(rotateRuler(r, 44))).toBe(45);
    expect(rulerAngleDeg(rotateRuler(r, 44, false))).toBe(44);
    expect(rulerAngleDeg(rotateRuler(r, -30))).toBe(150);
    const marks = rulerMarks(r, 595);
    expect(marks[0]).toEqual({ t: 0, major: true, label: '0' });
    expect(marks[2]!.t * r.length * 595).toBeCloseTo(PT_PER_CM, 6);
    const pr = projectOnEdge([0.5, 0], edge);
    expect(pr.t).toBeCloseTo(0.5, 6);
    // two fingers: the turn of the line between them
    const turned = twoFingerRuler(r, [0, 0], [100, 0], [0, 0], [100, 100], () => [0, 0]);
    expect(rulerAngleDeg(turned)).toBe(45);
  });
  it('the scale bar calibrates a picture; lengths and angles; the label; saved per picture on this device', () => {
    window.localStorage.clear();
    const img = { data: { v: 1 as const, image_key: 'H&E', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 }, mime: 'image/png' as const, natural_w: 1000, natural_h: 800, bytes: 1 } };
    const frame = frameAt([0.3, 0.2], K, [img], AR);
    expect(frame.kind).toBe('image');
    expect(frameAt([0.9, 0.9], K, [img], AR).kind).toBe('page');
    // a scale bar 0.1 page wide = 200 picture pixels, says 50 µm
    const barPx = frameLength([0.2, 0.2], [0.3, 0.2], frame, AR);
    expect(barPx).toBeCloseTo(200, 6);
    const cal = calibrate(barPx, 50, 'µm', 1)!;
    expect(realLength(frameLength([0.2, 0.25], [0.4, 0.25], frame, AR), cal)).toEqual({ value: 100, unit: 'µm' });
    expect(formatReal({ value: 100, unit: 'µm' })).toBe('100 µm');
    expect(calibrate(0, 50, 'µm')).toBeNull();
    expect(calibrate(10, -1, 'mm')).toBeNull();
    saveCalibration(frame, cal);
    expect(loadCalibration(frame)).toEqual(cal);
    expect(loadCalibration({ kind: 'page', targetKey: K })).toBeNull();
    expect(
      angleBetween(
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0, 0],
          [0, 1 / AR],
        ],
        AR,
      ),
    ).toBe(90);
    expect(EDUCATIONAL_LABEL_AR).toBe('تقدير تعليمي — ليس قياسًا سريريًا');
  });
});

describe('G22 snapping', () => {
  it('items, regions and the paper grid give lines; items win over the grid; a move snaps to the nearest edge', () => {
    const t = buildSnapTargets({ items: [{ x: 0.2, y: 0.2, w: 0.2, h: 0.1 }], regions: [{ x: 0.6, y: 0.5, w: 0.3, h: 0.2 }], pitch: { x: 0.05, y: 0.05 } });
    expect(t.xs.some((l) => l.source === 'region' && l.at === 0.6)).toBe(true);
    expect(nearestLine(t.xs, 0.201, 0.01)!.source).toBe('item');
    expect(nearestLine(t.xs, 0.251, 0.01)!.source).toBe('grid');
    // a box whose left edge lands 0.004 from the region's left edge snaps onto it
    const r = snapMove({ x: 0.5, y: 0.8, w: 0.05, h: 0.05 }, 0.104, 0, buildSnapTargets({ regions: [{ x: 0.6, y: 0.5, w: 0.3, h: 0.2 }] }), { x: 0.01, y: 0.01 });
    expect(r.dx).toBeCloseTo(0.1, 9);
    expect(r.guides[0]!.source).toBe('region');
    const p = snapPoint([0.402, 0.5], t, { x: 0.01, y: 0.001 });
    expect(p.at[0]).toBeCloseTo(0.4, 9);
    expect(paperPitch('ruled', 600, 800, { ruled: { pitch: 24, top: 72 }, dotted: { pitch: 20 }, grid: { pitch: 20 } })).toEqual({ x: 0.04, y: 0.03, y0: 0.09 });
    expect(paperPitch(null, 600, 800, { ruled: { pitch: 24, top: 72 }, dotted: { pitch: 20 }, grid: { pitch: 20 } })).toBeNull();
  });
});

describe('G21 connectors', () => {
  it('attach to the nearest side; follow a moved shape; a curve keeps its bend relative to the ends', () => {
    const a = shape('rect', [0.1, 0.1], [0.3, 0.2]);
    const b = shape('ellipse', [0.6, 0.1], [0.8, 0.2]);
    const hit = attachTarget([a, b], [0.31, 0.15], AR, 0.03);
    expect(hit?.item.id).toBe(a.id);
    expect(hit?.side).toBe('e');
    expect(hit?.at[0]).toBeCloseTo(0.3 + ATTACH_GAP, 6);
    // turned 90° clockwise: the east side faces down, the gap too
    const turned = attachPoint({ ...a.data, rotation: Math.PI / 2 }, 'e', AR)!;
    const side = shapeSidePoint({ ...a.data, rotation: Math.PI / 2 }, 'e', AR)!;
    expect(turned[0]).toBeCloseTo(side[0], 6);
    expect((turned[1] - side[1]) * AR).toBeCloseTo(ATTACH_GAP, 6);
    expect(nearestSide(b.data, [0.6, 0.15], AR)!.side).toBe('w');
    const conn = shape('curved_arrow', attachPoint(a.data, 'e', AR)!, attachPoint(b.data, 'w', AR)!, { control: [0.45, 0.1], attach: { from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } }, relation: 'causes' });
    expect(isConnector(conn)).toBe(true);
    const movedB = { ...b, data: { ...b.data, from: [0.6, 0.4] as [number, number], to: [0.8, 0.5] as [number, number] } };
    const page = new Map<string, InkItem>([
      [a.id, a],
      [b.id, b],
      [conn.id, conn],
    ]);
    const follow = followConnectors(page, [{ id: b.id, targetKey: K, before: b, after: movedB }], K, AR, 9);
    expect(follow.length).toBe(1);
    const nc = follow[0]!.after as InkItemOf<ShapeData>;
    // the end sits a small gap outside the side (a head drawn there is not lost in the outline)
    expect(nc.data.to[0]).toBeCloseTo(0.6 - ATTACH_GAP, 5);
    expect(nc.data.to[1]).toBeCloseTo(0.45, 5);
    expect(nc.data.from).toEqual(conn.data.from);
    expect(nc.data.control![1]).toBeCloseTo(0.1 + 0.15, 5); // the middle moved by half of the end's move
    expect(nc.data.attach).toEqual(conn.data.attach);
    // a deleted shape leaves the end where it was
    expect(rerouteConnector(conn, (id) => (id === b.id ? { ...b, deleted_at: 5 } : page.get(id)), AR, 9)).toBe(conn);
    expect(connectorSentence(conn.data, (id) => (id === a.id ? 'Insulin' : 'GLUT4'))).toBe('«Insulin» يسبّب «GLUT4»');
  });
  it('«add a connected shape» copies the node beside it with an attached arrow; auto layout lays out a chain', () => {
    const a = shape('rect', [0.1, 0.1], [0.3, 0.2], { fill: 'hl-blue' });
    const plan = connectedShapePlan(a, 's', AR, 3, { shape: 'S2', connector: 'C2' }, 10);
    expect(plan.shape.data.shape).toBe('rect');
    expect(plan.shape.data.fill).toBe('hl-blue');
    expect(plan.shape.data.from[1]).toBeGreaterThan(0.2);
    expect(plan.connector.data.attach).toEqual({ from: { id: a.id, side: 's' }, to: { id: 'S2', side: 'n' } });
    const c = shape('rect', [0.5, 0.1], [0.7, 0.2]);
    const link = (x: InkItemOf<ShapeData>, y: InkItemOf<ShapeData>) => shape('arrow', [0, 0], [0, 0], { attach: { from: { id: x.id, side: 's' }, to: { id: y.id, side: 'n' } } });
    const moves = autoLayoutPlan([a, plan.shape, c], [link(a, plan.shape), link(plan.shape, c)], AR, true, 4);
    const y = (id: string) => {
      const m = moves.find((x) => x.id === id);
      const d = ((m?.after ?? [a, plan.shape, c].find((n) => n.id === id)) as InkItemOf<ShapeData>).data;
      return (d.from[1] + d.to[1]) / 2;
    };
    expect(y(a.id)).toBeLessThan(y(plan.shape.id));
    expect(y(plan.shape.id)).toBeLessThan(y(c.id));
  });
  it('the relation check reads the knowledge map; «inhibits» has no Course Brain kind; unbound ends say so', () => {
    const d = shape('arrow', [0, 0], [1, 1], { relation: 'treats' }).data;
    const rel = [{ from: { id: 'c1' }, to: { id: 'c2' }, relation: 'treats', support: 'stated' as const, status: 'active' }];
    expect(checkRelation(d, { from: 'c1', to: 'c2' }, rel)).toEqual({ status: 'found', support: 'stated' });
    expect(checkRelation(d, { from: 'c2', to: 'c1' }, rel)).toEqual({ status: 'missing' });
    expect(checkRelation({ ...d, relation: 'inhibits' }, { from: 'c1', to: 'c2' }, rel)).toEqual({ status: 'no_kind' });
    expect(checkRelation(d, { from: null, to: 'c2' }, rel)).toEqual({ status: 'unbound' });
    expect(checkRelation(d, { from: 'c1', to: 'c2' }, [{ ...rel[0]!, status: 'rejected' }])).toEqual({ status: 'missing' });
  });
});

describe('G07 eyedropper', () => {
  it('reads colours as #rrggbb; composites the canvases as drawn (multiply for highlights)', () => {
    expect(toHex('#AbC')).toBe('#aabbcc');
    expect(toHex('rgb(200, 10, 255)')).toBe('#c80aff');
    expect(toHex('purple')).toBeNull();
    expect(composite([255, 255, 255, 255], [200, 100, 150, 255])).toEqual([200, 100, 150, 255]);
    expect(composite([200, 100, 150, 255], [255, 255, 0, 255], 'multiply')).toEqual([200, 100, 0, 255]);
    expect(composite([10, 20, 30, 255], [0, 0, 0, 0])).toEqual([10, 20, 30, 255]);
    expect(eyedropperPath()).toBe('canvas'); // jsdom has no EyeDropper
    const rows = buildCapabilityReport(detectApiSupport(), EMPTY_OBSERVATIONS, { eyedropper: 'canvas' });
    const row = rows.find((r) => r.key === 'eyedropper')!;
    expect(row.state).toBe('heuristic');
    expect(buildCapabilityReport(detectApiSupport(), EMPTY_OBSERVATIONS, { eyedropper: 'api' }).find((r) => r.key === 'eyedropper')!.state).toBe('supported');
  });
});

describe('settings parts (ink object)', () => {
  it('snapping on by default, the zoom window right to left by default (auto), the pencil has its own feel', () => {
    expect(DEFAULT_INK_SETTINGS.snap).toEqual({ enabled: true, items: true, grid: true, regions: true });
    expect(DEFAULT_INK_SETTINGS.zoom.direction).toBe('auto');
    expect(DEFAULT_INK_SETTINGS.zoom.auto_advance).toBe(true);
    expect(DEFAULT_INK_SETTINGS.feel.pencil).toBeTruthy();
    // the pencil keeps its own colour slots (absent = the built-in palette)
    expect(DEFAULT_INK_SETTINGS.palettes.pencil).toBeUndefined();
    expect(inkSettingsSchema.parse({ palettes: { pencil: [{ color: 'ink-black', dash: 'dot' }] } }).palettes.pencil).toEqual([{ color: 'ink-black', dash: 'dot' }]);
  });
});
