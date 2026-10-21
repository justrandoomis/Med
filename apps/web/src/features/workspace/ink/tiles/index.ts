// The app-wide ink tile cache (one per tab) and the bits around it: whether tiles are used, the memory budget, the
// store tracker that keeps off-screen grids honest, and the paint log the performance harness reads.
import type { NormBox } from '@medlevo/shared';
import type { InkDocumentStore } from '../store';
import { InkTileCache, type SurfaceFactory, type TileSurface } from './tileCache';
import { deviceStorage } from '../../../../lib/userStorage';

export { InkTileCache, TILE_PX, TileGrid, type GridKey, type DeviceRect, type TileSurface } from './tileCache';

/** Pages with fewer committed items than this paint stroke by stroke as before (cheap; no bitmaps kept). */
export const TILE_MIN_ITEMS = 400;

const browserSurface: SurfaceFactory = (w, h) => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  // tiles are drawn on the CPU and read back once per slice to know what the drawing really cost (see renderer.ts)
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? ({ canvas, ctx } as TileSurface) : null;
};

/** Budget: 96 MB, 48 MB on devices reporting ≤ 4 GB of memory, 24 MB in «خفيف» (lite) display mode. */
export function tileBudgetBytes(): number {
  const MB = 1024 * 1024;
  try {
    if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-lite')) return 24 * MB;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof mem === 'number' && mem <= 4) return 48 * MB;
  } catch {
    // no navigator (tests)
  }
  return 96 * MB;
}

let shared: InkTileCache | null = null;
export function inkTileCache(): InkTileCache {
  if (!shared) shared = new InkTileCache(browserSurface, { budgetBytes: tileBudgetBytes });
  return shared;
}

/** Tests only. */
export function __setInkTileCache(c: InkTileCache | null): void {
  shared?.dropAll();
  shared = c;
  tracked.clear();
}

/**
 * Tiles on/off: on by default; `localStorage['medlevo.ink.tiles'] = 'off'` turns them off (the performance harness
 * measures «before» with the same build this way).
 */
export function tilesEnabled(): boolean {
  try {
    return deviceStorage.get('medlevo.ink.tiles') !== 'off';
  } catch {
    return true;
  }
}

// ─── store tracking: grids of pages not on screen follow the page's changes ─────────────────────
const storeIds = new WeakMap<InkDocumentStore, string>();
let storeSeq = 0;
export function storeKeyOf(store: InkDocumentStore): string {
  let k = storeIds.get(store);
  if (!k) storeIds.set(store, (k = `s${++storeSeq}:${store.documentKey}`));
  return k;
}

const tracked = new Set<string>();
/** Subscribes the cache to a page's events once (the store keeps pages for the app's lifetime). */
export function trackPage(store: InkDocumentStore, targetKey: string): void {
  const sk = storeKeyOf(store);
  const id = `${sk}\u0001${targetKey}`;
  if (tracked.has(id)) return;
  tracked.add(id);
  try {
    store.subscribePage(targetKey, (e) => {
      const cache = shared;
      if (!cache) return;
      if (e.kind === 'loaded') cache.pageChanged(sk, targetKey, 'all');
      else if (e.kind === 'items') cache.pageChanged(sk, targetKey, e.dirty);
      else if (e.kind === 'hidden') {
        const page = store.page(targetKey);
        const boxes: NormBox[] = [];
        for (const itemId of e.ids) {
          const b = page?.index.box(itemId);
          if (b) boxes.push(b);
        }
        cache.pageChanged(sk, targetKey, boxes);
      }
    });
  } catch {
    tracked.delete(id);
  }
}

// ─── paint log for the performance harness (off unless the page opts in) ─────────────────────────
export interface InkPaintRecord {
  targetKey: string;
  /** 'full' = the whole committed layer; 'dirty' = dirty rectangles only */
  kind: 'full' | 'dirty';
  mode: 'tiles' | 'strokes';
  /** ms from the start of the repaint until the last tile / stroke was on the canvas */
  ms: number;
  warmTiles: number;
  coldTiles: number;
  items: number;
  /** wall-clock start (performance.now()) */
  at: number;
  /** the grid's view key (canvas size, transform, tone) — tiles mode only, for the harness */
  view?: string;
}

export function recordInkPaint(r: InkPaintRecord): void {
  const w = globalThis as unknown as { __medlevoInkPerf?: boolean; __medlevoInkPaints?: InkPaintRecord[] };
  if (!w.__medlevoInkPerf) return;
  (w.__medlevoInkPaints ??= []).push(r);
}
