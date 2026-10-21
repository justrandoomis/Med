// Paints one page's committed ink through the tile cache (Academic OS P1-T2 step 2; ADR-0005 B.3).
//
//   full repaint  → valid tiles are copied onto the page canvases at once («warm»); the other tiles are drawn stroke by
//                   stroke in slices of a few milliseconds per frame (never one long task), each snapshotted into the
//                   cache when done. While a zoom step re-rasters, the previous picture, scaled, stands in for the tiles
//                   not drawn yet;
//   dirty repaint → the controller draws the dirty rectangles exactly as before; the painter then refreshes the
//                   snapshot of the valid tiles those rectangles touch, so the grid on screen never goes stale.
import type { NormBox } from '@medlevo/shared';
import { expandBox, type Mat } from '../math';
import { isInkStroke, isShape, type InkItem } from '../model';
import { deviceRectOf, drawItem, paintOrder, type RenderEnv } from '../render';
import type { InkDocumentStore, PageModel } from '../store';
import type { InkPageView } from '../types';
import { inkTileCache, recordInkPaint, storeKeyOf, TILE_MIN_ITEMS, tilesEnabled, trackPage, type DeviceRect, type GridKey, type InkTileCache, type TileGrid } from './index';

/** Main-thread budget per frame for drawing cold tiles (raster included). */
export const SLICE_MS = 8;
const MAX_CHUNK = 64;
const isHighlighter = (it: InkItem) => isInkStroke(it) && it.data.style.tool === 'highlighter';

export interface PainterDeps {
  store: InkDocumentStore;
  targetKey: string;
  hlCanvas: HTMLCanvasElement;
  inkCanvas: HTMLCanvasElement;
  hlCtx: CanvasRenderingContext2D;
  inkCtx: CanvasRenderingContext2D;
  getView: () => InkPageView;
  getMatrix: () => Mat;
  getEnv: () => RenderEnv;
  /** test seams */
  cache?: InkTileCache;
  now?: () => number;
  schedule?: (fn: () => void) => number;
  cancel?: (h: number) => void;
  enabled?: () => boolean;
}

interface Job {
  index: number;
  items: InkItem[] | null;
  pos: number;
  hasHl: boolean;
  hasInk: boolean;
}

/** The page-normalized box a device rect of the canvas covers (inverse of the page matrix). */
export function normBoxOfDeviceRect(r: DeviceRect, view: InkPageView, m: Mat): NormBox {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const inv = (x: number, y: number): [number, number] => {
    const dx = x - m[4];
    const dy = y - m[5];
    const u = (m[3] * dx - m[2] * dy) / det;
    const v = (-m[1] * dx + m[0] * dy) / det;
    return [u / view.pageWidth, v / view.pageHeight];
  };
  const pts = [inv(r.x, r.y), inv(r.x + r.w, r.y), inv(r.x, r.y + r.h), inv(r.x + r.w, r.y + r.h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export class TiledPainter {
  private grid: TileGrid | null = null;
  private queue: Job[] = [];
  private frame = 0;
  private started = 0;
  private warm = 0;
  private cold = 0;
  private itemsDrawn = 0;
  private previous: HTMLCanvasElement | null = null;
  private previousRotation: number | null = null;
  /** measured cost of one stroke (recording + raster), adapted after every chunk */
  private perItemMs = 0.5;
  private readonly cache: InkTileCache;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => number;
  private readonly cancel: (h: number) => void;
  private readonly enabled: () => boolean;

  constructor(private readonly d: PainterDeps) {
    this.cache = d.cache ?? inkTileCache();
    this.now = d.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.schedule = d.schedule ?? ((fn) => requestAnimationFrame(fn));
    this.cancel = d.cancel ?? ((h) => cancelAnimationFrame(h));
    this.enabled = d.enabled ?? tilesEnabled;
    trackPage(d.store, d.targetKey);
  }

  /** Does this page paint through tiles? (dense pages only, and only while tiles are on) */
  use(page: PageModel): boolean {
    return this.enabled() && page.items.size >= TILE_MIN_ITEMS;
  }

  /** true while cold tiles are still being drawn */
  get busy(): boolean {
    return this.queue.length > 0;
  }

  get liveGrid(): TileGrid | null {
    return this.grid;
  }

  private key(): GridKey {
    const view = this.d.getView();
    const env = this.d.getEnv();
    const m = this.d.getMatrix();
    return {
      storeKey: storeKeyOf(this.d.store),
      targetKey: this.d.targetKey,
      // (P1-T2 review) the resolved palette is part of the view: a tile is a bitmap of the colours it was drawn in
      viewKey: `${this.d.inkCanvas.width}x${this.d.inkCanvas.height}|${m.map((v) => Math.round(v * 1e6) / 1e6).join(',')}|${view.pageWidth}x${view.pageHeight}|${env.tone}|${env.highlightAlpha ?? ''}|${env.palette ?? ''}`,
      visKey: this.d.store.visibilityKey,
    };
  }

  private acquire(): TileGrid {
    const view = this.d.getView();
    const m = this.d.getMatrix();
    const g = this.cache.grid(this.key(), {
      cw: this.d.inkCanvas.width,
      ch: this.d.inkCanvas.height,
      toDevice: (b) => deviceRectOf(b, view, m, 3),
    });
    if (g !== this.grid) {
      if (this.grid) this.grid.live = Math.max(0, this.grid.live - 1);
      g.live++;
      this.grid = g;
    }
    return g;
  }

  /** Before the canvases are resized (zoom): keep the current picture to stand in while the new scale re-rasters. */
  capturePrevious(): void {
    if (!this.grid || typeof document === 'undefined') return;
    const src = this.d.inkCanvas;
    if (!src.width || !src.height) return;
    try {
      const c = this.previous ?? document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(this.d.hlCanvas, 0, 0);
      ctx.drawImage(src, 0, 0);
      this.previous = c;
      this.previousRotation = this.d.getView().rotation;
    } catch {
      this.previous = null;
    }
  }

  /** The page's content changed as a whole (reload): every tile of the grid on screen is redrawn. */
  contentReset(): void {
    this.grid?.markStale('all');
  }

  /** Some content changed over a large area: those tiles are redrawn. */
  contentChanged(boxes: readonly NormBox[]): void {
    this.grid?.markStale(boxes);
  }

  /** Repaint the whole committed layer: warm tiles now, cold ones in slices. */
  full(): void {
    const g = this.acquire();
    this.cancel(this.frame);
    this.frame = 0;
    this.started = this.now();
    this.warm = 0;
    this.cold = 0;
    this.itemsDrawn = 0;
    const { hlCtx, inkCtx } = this.d;
    const cw = this.d.inkCanvas.width;
    const ch = this.d.inkCanvas.height;
    for (const ctx of [hlCtx, inkCtx]) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const stale = g.tiles.filter((t) => t.state !== 'valid').length;
    const prev = this.previous;
    if (stale > 0 && prev && this.previousRotation === this.d.getView().rotation) {
      // stand-in: the previous picture scaled to the new size (hl + ink flattened onto the ink canvas)
      hlCtx.clearRect(0, 0, cw, ch);
      inkCtx.clearRect(0, 0, cw, ch);
      try {
        inkCtx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, cw, ch);
      } catch {
        // a lost canvas: no stand-in
      }
    }
    // otherwise what is on the canvas stays until each cold tile is redrawn (a layer shown / hidden: no blank flash)
    this.previous = null;
    this.queue = [];
    g.tiles.forEach((t, i) => {
      if (t.state === 'valid') {
        this.cache.blit(t, { hl: hlCtx, ink: inkCtx });
        this.warm++;
      } else {
        this.queue.push({ index: i, items: null, pos: 0, hasHl: false, hasInk: false });
        this.cold++;
      }
    });
    for (const ctx of [hlCtx, inkCtx]) ctx.restore();
    if (this.queue.length === 0) this.finish();
    else this.slice();
  }

  /** After the controller repainted dirty rectangles: refresh the valid tiles they touch; restart a tile being drawn. */
  afterDirty(rects: readonly DeviceRect[]): void {
    const g = this.grid;
    if (!g) return;
    const from = { hl: this.d.hlCanvas, ink: this.d.inkCanvas };
    for (const r of rects) {
      this.cache.refresh(g, r, from);
      const touched = new Set(g.tilesIn(r));
      for (const job of this.queue) if (job.items && touched.has(job.index)) Object.assign(job, { items: null, pos: 0, hasHl: false, hasInk: false });
    }
  }

  /** Draw every cold tile now (tests; a synchronous repaint). */
  flush(): void {
    if (!this.queue.length) return;
    this.cancel(this.frame);
    this.frame = 0;
    while (this.queue.length) this.runSlice(Infinity);
    this.finish();
  }

  /** The layer goes away: cold tiles stay stale; changes not painted yet mark their tiles stale. */
  destroy(pending: readonly NormBox[] | 'all' | null, contentReset: boolean): void {
    this.cancel(this.frame);
    this.frame = 0;
    this.queue = [];
    const g = this.grid;
    if (g) {
      if (contentReset) g.markStale('all');
      else if (pending && pending !== 'all') g.markStale(pending);
      g.live = Math.max(0, g.live - 1);
      this.grid = null;
    }
    this.previous = null;
    this.cache.evict();
  }

  /** Leave tile mode (the page became light): forget the grid on screen. */
  leave(): void {
    this.cancel(this.frame);
    this.frame = 0;
    this.queue = [];
    if (this.grid) {
      this.grid.live = Math.max(0, this.grid.live - 1);
      this.grid.markStale('all');
      this.grid = null;
    }
  }

  private slice = () => {
    this.frame = 0;
    this.runSlice(SLICE_MS);
    if (this.queue.length) this.frame = this.schedule(this.slice);
    else this.finish();
  };

  /**
   * Draws cold tiles for about `budget` ms. Canvas drawing is recorded cheaply and RASTERIZED later (at the end of
   * the frame or on a read): timing the drawing calls alone lets one slice queue seconds of raster work (measured: 1 000
   * realistic strokes record in 14 ms and rasterize in 450 ms). So each tile is drawn into its own surface and read back
   * (1 px) after every chunk: the clock then includes the raster, and the chunk size adapts to the measured cost.
   */
  private runSlice(budget: number): void {
    const g = this.grid;
    if (!g) {
      this.queue = [];
      return;
    }
    const t0 = this.now();
    const store = this.d.store;
    const view = this.d.getView();
    const m = this.d.getMatrix();
    const env = this.d.getEnv();
    while (this.queue.length && this.now() - t0 < budget) {
      const job = this.queue[0]!;
      const tile = g.tiles[job.index]!;
      const r = tile.rect;
      if (!job.items) {
        const box = expandBox(normBoxOfDeviceRect(r, view, m), 0.002);
        job.items = store
          .query(this.d.targetKey, box)
          .filter((it) => !store.isHidden(it.id) && (isInkStroke(it) || isShape(it)) && store.isVisible(it))
          .sort(paintOrder);
        job.pos = 0;
        job.hasHl = job.items.some(isHighlighter);
        job.hasInk = job.items.some((it) => !isHighlighter(it));
        this.cache.prepare(tile, { hl: job.hasHl, ink: job.hasInk });
      }
      const left = budget - (this.now() - t0);
      const n = Math.max(1, Math.min(MAX_CHUNK, Math.floor(left / Math.max(0.01, this.perItemMs))));
      const end = Math.min(job.items.length, job.pos + n);
      const surfaces = [tile.hl, tile.ink];
      for (const s of surfaces) s?.ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - r.x, m[5] - r.y);
      const c0 = this.now();
      for (let i = job.pos; i < end; i++) {
        const it = job.items[i]!;
        const target = isHighlighter(it) ? tile.hl : tile.ink;
        if (target) drawItem(target.ctx, it, env);
      }
      // make the raster happen now, inside this slice (and inside the clock)
      for (const s of surfaces) s?.ctx.getImageData(0, 0, 1, 1);
      const per = (this.now() - c0) / Math.max(1, end - job.pos);
      this.perItemMs = this.perItemMs * 0.5 + per * 0.5;
      this.itemsDrawn += end - job.pos;
      job.pos = end;
      if (job.pos >= job.items.length) {
        tile.state = 'valid';
        const { hlCtx, inkCtx } = this.d;
        for (const ctx of [hlCtx, inkCtx]) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        this.cache.blit(tile, { hl: hlCtx, ink: inkCtx });
        hlCtx.restore();
        inkCtx.restore();
        this.queue.shift();
      }
    }
  }

  private finish(): void {
    recordInkPaint({ targetKey: this.d.targetKey, kind: 'full', mode: 'tiles', ms: Math.round((this.now() - this.started) * 10) / 10, warmTiles: this.warm, coldTiles: this.cold, items: this.itemsDrawn, at: this.started, view: this.grid?.key.viewKey });
    this.cache.evict();
  }
}
