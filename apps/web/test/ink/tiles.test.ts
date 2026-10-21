// P1-T2 step 2 — the dense-page ink tile cache (ADR-0005 B.3; PRD NFR-P2, AOS-1.39, OC.8). A page with thousands of
// strokes repaints from bitmap tiles when the view was seen before («warm»: no stroke is drawn again), draws cold tiles
// in short slices (never one long task), keeps the grid on screen current through dirty-rectangle repaints, follows
// changes made while the page is off screen, keys grids by the visible-layer set, and stays inside a memory budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { PageInkController } from '../../src/features/workspace/ink/layerController';
import { makeInkItem, type InkItem } from '../../src/features/workspace/ink/model';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import type { InkToolState } from '../../src/features/workspace/ink/types';
import { __setInkTileCache, InkTileCache, TILE_MIN_ITEMS, TILE_PX, type TileSurface } from '../../src/features/workspace/ink/tiles';
import { normBoxOfDeviceRect, SLICE_MS } from '../../src/features/workspace/ink/tiles/renderer';

const T = 1_800_000_000_000;
const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC', version_id: 'VER', page_id: 'P1', page_index: 0, space: 'page_norm' };
const KEY = 'source_page:P1';

if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    moveTo() {}
    lineTo() {}
    quadraticCurveTo() {}
    bezierCurveTo() {}
    closePath() {}
    arc() {}
    rect() {}
    ellipse() {}
    addPath() {}
  };
}

function line(id: string, x: number, y: number, layerId: string | null = null): InkItem {
  const points: InkPoint[] = Array.from({ length: 6 }, (_, k) => [x + k * 0.004, y + (k % 2) * 0.002, k * 8]);
  return { ...makeInkItem({ id, anchor, now: T, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.003 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' }), layer_id: layerId };
}

/** a dense page: n strokes spread over the page; the first `onLayer` of them on layer 'L2' */
function dense(n: number, onLayer = 0): InkItem[] {
  return Array.from({ length: n }, (_, i) => line(`S${i}`, 0.05 + ((i * 37) % 85) / 100, 0.05 + ((i * 53) % 85) / 100, i < onLayer ? 'L2' : null));
}

let counts: { stroke: number; blit: number; snapshot: number; surfaces: number };
/** a fake clock that drawing advances (the slicing test) */
let fakeClock = 0;
let strokeCost = 0;
function fakeContext() {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'stroke')
          return () => {
            counts.stroke++;
            fakeClock += strokeCost;
          };
        if (prop === 'drawImage') return () => void counts.blit++;
        if (prop === 'getContextAttributes') return () => ({});
        if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}
const fakeSurface = (w: number, h: number): TileSurface => {
  counts.surfaces++;
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'drawImage') return () => void counts.snapshot++;
        // cold tiles are drawn into their own surface (then copied onto the page canvases)
        if (prop === 'stroke')
          return () => {
            counts.stroke++;
            fakeClock += strokeCost;
          };
        if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { canvas: { width: w, height: h } as unknown as HTMLCanvasElement, ctx };
};

let db: MedLevoDB;
let store: InkDocumentStore;
let cache: InkTileCache;
let view = { pageWidth: 600, pageHeight: 750, scale: 1, rotation: 0 as const };
const controllers: PageInkController[] = [];

function mount(): PageInkController {
  const canvases = ['hl', 'ink', 'live'].map(() => document.createElement('canvas'));
  vi.spyOn(canvases[0]!, 'getContext').mockReturnValue(fakeContext() as never);
  vi.spyOn(canvases[1]!, 'getContext').mockReturnValue(fakeContext() as never);
  vi.spyOn(canvases[2]!, 'getContext').mockReturnValue(null);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const tool: InkToolState = { tool: 'pen', color: 'ink-blue', width: 0.003, penOnly: false, shapeRecognition: false };
  const c = new PageInkController({
    store,
    targetKey: KEY,
    root,
    highlightCanvas: canvases[0]!,
    inkCanvas: canvases[1]!,
    liveCanvas: canvases[2]!,
    getAnchor: () => anchor,
    getView: () => view,
    getTool: () => tool,
    getInteractive: () => true,
    onStrokeActive: () => undefined,
    onTextRequest: () => undefined,
  });
  c.setView();
  controllers.push(c);
  return c;
}

/** one full repaint (synchronously finished), with the counters of that repaint */
function repaint(c: PageInkController) {
  counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
  c.invalidate('all');
  c.paintCommitted();
  c.flushTiles();
  return { ...counts };
}

beforeEach(async () => {
  counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
  view = { pageWidth: 600, pageHeight: 750, scale: 1, rotation: 0 };
  cache = new InkTileCache(fakeSurface, { budgetBytes: 512 * 1024 * 1024 });
  __setInkTileCache(cache);
  db = new MedLevoDB(`medlevo-tiles-${newId()}`);
  await db.open();
  store = new InkDocumentStore(`doc-${newId()}`, db, () => T, { persistHistory: false });
  store.attachPage(KEY, anchor, 1.25);
  await store.whenLoaded(KEY);
  try {
    localStorage.removeItem('medlevo.ink.tiles');
  } catch {
    // no storage
  }
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.destroy());
  store.dispose();
  __setInkTileCache(null);
});

const fixture = (items: InkItem[]) => store.commit('fixture', items.map((it) => ({ id: it.id, targetKey: KEY, before: null, after: it })));

describe('tile grid geometry', () => {
  it('splits the page canvas into tiles and maps device rects back to page boxes', () => {
    fixture(dense(TILE_MIN_ITEMS));
    const c = mount();
    repaint(c);
    const g = cache.stats();
    expect(g.grids).toBe(1);
    // 600 × 750 device px at dpr 1 → 2 × 2 tiles of 512
    expect(g.validTiles).toBe(Math.ceil(600 / TILE_PX) * Math.ceil(750 / TILE_PX));
    const box = normBoxOfDeviceRect({ x: 0, y: 0, w: 300, h: 375 }, view, [1, 0, 0, 1, 0, 0]);
    expect(box.x).toBeCloseTo(0);
    expect(box.w).toBeCloseTo(0.5);
    expect(box.h).toBeCloseTo(0.5);
    const rotated = normBoxOfDeviceRect({ x: 0, y: 0, w: 750, h: 600 }, view, [0, 1, -1, 0, 750, 0]);
    expect(rotated.w).toBeCloseTo(1);
    expect(rotated.h).toBeCloseTo(1);
  });
});

describe('dense page repaint through tiles', () => {
  it('a warm repaint draws no stroke again: every tile is copied from the cache', () => {
    fixture(dense(1200));
    const c = mount();
    const cold = repaint(c);
    expect(cold.stroke).toBeGreaterThanOrEqual(1200);
    expect(cold.surfaces).toBeGreaterThan(0); // tile surfaces were drawn into
    expect(cold.blit).toBeGreaterThan(0); // and copied onto the page
    const warm = repaint(c);
    expect(warm.stroke).toBe(0);
    expect(warm.blit).toBeGreaterThan(0);
    expect(warm.blit).toBeLessThanOrEqual(2 * 4);
  });

  it('a light page paints stroke by stroke as before (no bitmaps kept)', () => {
    fixture(dense(TILE_MIN_ITEMS - 1));
    const c = mount();
    expect(repaint(c).stroke).toBe(TILE_MIN_ITEMS - 1);
    expect(repaint(c).stroke).toBe(TILE_MIN_ITEMS - 1);
    expect(cache.stats().grids).toBe(0);
  });

  it('tiles can be turned off (the harness measures «before» this way)', () => {
    localStorage.setItem('medlevo.ink.tiles', 'off');
    fixture(dense(800));
    const c = mount();
    repaint(c);
    expect(repaint(c).stroke).toBe(800);
    expect(cache.stats().grids).toBe(0);
  });

  it('cold tiles are drawn in slices of a few milliseconds per frame, never in one long task', () => {
    fakeClock = 0;
    strokeCost = 0.25; // every drawn stroke costs 0.25 ms on the fake clock
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => fakeClock);
    const frames: Array<() => void> = [];
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn: FrameRequestCallback) => (frames.push(() => fn(0)), frames.length));
    try {
      fixture(dense(2000));
      mount(); // its first paint is queued for the next frame
      counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
      const slices: number[] = [];
      let guard = 0;
      while (frames.length && guard++ < 1000) {
        const before = fakeClock;
        frames.shift()!();
        slices.push(fakeClock - before);
      }
      expect(counts.stroke).toBeGreaterThanOrEqual(2000);
      expect(slices.length).toBeGreaterThan(10);
      // a slice stops once its budget is spent; the chunk size follows the measured cost of a stroke
      expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS + 2 * strokeCost + 0.01);
      // the old path drew the same 2 000 strokes in ONE task: 500 ms on this clock
      expect(slices.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000 * strokeCost);
    } finally {
      strokeCost = 0;
      perf.mockRestore();
      raf.mockRestore();
    }
  });

  it('writing on a warm page keeps the grid on screen current: the next repaint is still fully warm', () => {
    fixture(dense(900));
    const c = mount();
    repaint(c);
    const s = line('NEW', 0.4, 0.4);
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
    c.paintCommitted(); // the dirty-rectangle repaint
    expect(counts.stroke).toBeGreaterThan(0);
    expect(counts.stroke).toBeLessThan(900);
    expect(counts.snapshot).toBeGreaterThan(0); // the touched tiles' snapshot refreshed
    expect(repaint(c).stroke).toBe(0);
  });

  it('a page changed while off screen: its tiles there go stale, the others stay warm', () => {
    fixture(dense(900));
    const first = mount();
    repaint(first);
    first.destroy();
    controllers.splice(controllers.indexOf(first), 1);
    // a stroke arrives while the page is not shown (e.g. from sync), in the top-left tile only
    const s = line('REMOTE', 0.05, 0.05);
    store.commit('مزامنة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const again = mount();
    const r = repaint(again);
    expect(r.stroke).toBeGreaterThan(0);
    expect(r.stroke).toBeLessThan(901);
    expect(r.blit).toBeGreaterThan(0); // the untouched tiles were copied, not redrawn
  });

  it('a reload of the page (all items replaced) redraws every tile', () => {
    fixture(dense(700));
    const c = mount();
    repaint(c);
    counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
    (c as unknown as { onPageEvent(e: unknown): void }).onPageEvent({ kind: 'items', dirty: 'all', ids: [] });
    c.paintCommitted();
    c.flushTiles();
    expect(counts.stroke).toBeGreaterThanOrEqual(700);
  });
});

describe('layers and tiles', () => {
  it('hiding a layer uses its own grid; showing it again is warm (5 layers, nothing hidden drawn)', () => {
    const items = Array.from({ length: 1000 }, (_, i) => line(`S${i}`, 0.05 + ((i * 37) % 85) / 100, 0.05 + ((i * 53) % 85) / 100, i % 5 === 0 ? null : `L${i % 5}`));
    fixture(items);
    const c = mount();
    const all = repaint(c);
    expect(all.stroke).toBeGreaterThanOrEqual(1000);
    store.setVisibility((it) => it.layer_id !== 'L2', 'doc|L2');
    const hidden = repaint(c);
    expect(hidden.stroke).toBeGreaterThanOrEqual(800);
    expect(hidden.stroke).toBeLessThan(all.stroke);
    store.setVisibility(null);
    expect(repaint(c).stroke).toBe(0); // the «everything visible» grid is still warm
    store.setVisibility((it) => it.layer_id !== 'L2', 'doc|L2');
    expect(repaint(c).stroke).toBe(0); // and so is the one without L2
  });

  it('an editability-only change (lock a layer) repaints nothing', () => {
    fixture(dense(600));
    const c = mount();
    repaint(c);
    counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
    store.setEditability(() => false);
    c.paintCommitted();
    expect(counts.stroke).toBe(0);
    expect(counts.blit).toBe(0);
  });
});

describe('memory', () => {
  it('grids beyond the budget are evicted least recently used first; the grid on screen stays', () => {
    cache.budgetBytes = 1;
    fixture(dense(500));
    const c = mount();
    repaint(c);
    view = { ...view, scale: 1.5 };
    c.setView();
    repaint(c);
    // the earlier zoom level's grid went; the current one is kept even over budget
    expect(cache.stats().grids).toBe(1);
    expect(cache.stats().validTiles).toBe(Math.ceil(900 / TILE_PX) * Math.ceil(1125 / TILE_PX));
  });

  it('a zoom step back to a scale seen before is warm', () => {
    fixture(dense(1500));
    const c = mount();
    repaint(c);
    view = { ...view, scale: 1.25 };
    c.setView();
    expect(repaint(c).stroke).toBeGreaterThan(0);
    view = { ...view, scale: 1 };
    c.setView();
    expect(repaint(c).stroke).toBe(0);
  });
});

// (P1-T2 review) the tiles are bitmaps of RESOLVED colours: a change of the ink palette (e-ink / high contrast / theme
// tokens) must never blit the previous palette's warm tiles
describe('display modes and tiles', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-eink');
    document.getElementById('tiles-eink-style')?.remove();
  });

  it('switching e-ink on (ink tokens turn grey) redraws a dense page instead of copying the coloured tiles; switching back is warm again', async () => {
    const style = document.createElement('style');
    style.id = 'tiles-eink-style';
    style.textContent = ".tiles-root { --ml-ink-c-ink-blue: #2346c8; } :root[data-eink='on'] .tiles-root { --ml-ink-c-ink-blue: #141414; }";
    document.head.appendChild(style);
    fixture(dense(900));
    const c = mount();
    ((c as unknown as { d: { root: HTMLElement } }).d.root).classList.add('tiles-root');
    repaint(c);
    expect(repaint(c).stroke).toBe(0); // warm in the normal palette
    // count from the switch on: the controller's own observer may already repaint (in an animation frame) before ours
    counts = { stroke: 0, blit: 0, snapshot: 0, surfaces: 0 };
    document.documentElement.setAttribute('data-eink', 'on');
    await new Promise((r) => setTimeout(r, 0)); // the controller's MutationObserver
    c.invalidate('all');
    c.paintCommitted();
    c.flushTiles();
    expect(counts.stroke).toBeGreaterThanOrEqual(900); // every stroke drawn again in the grey palette
    expect(repaint(c).stroke).toBe(0); // and the e-ink grid is warm from now on
    document.documentElement.removeAttribute('data-eink');
    await new Promise((r) => setTimeout(r, 0));
    expect(repaint(c).stroke).toBe(0); // the normal palette's grid was kept
  });
});
