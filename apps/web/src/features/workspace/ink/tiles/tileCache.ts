// Dense-page ink tile cache (Academic OS P1-T2 step 2; ADR-0005 B.3; PRD NFR-P2, AOS-1.39, OC.8).
//
// A page with thousands of committed strokes used to be repainted stroke by stroke on every zoom step, every remount
// (scrolling the page out and back) and every layer show / hide: 397 ms in one long task in the CI harness, 3–4 s with
// software raster. The cache keeps the page's committed ink as BITMAP TILES, one grid per
//   page × view (canvas size, scale, rotation, paper tone) × visible-layer set,
// so a repaint of a view seen before («warm») is a few image copies instead of thousands of strokes.
//
// Rules that keep it correct:
//   * the visible canvas is the truth; a tile is a snapshot of a region of it, taken right after that region was painted
//     (a dirty-rectangle repaint refreshes the snapshot of the tiles it touched);
//   * the cache follows the store: every change to a page's items marks the overlapping tiles of the page's OTHER grids
//     stale (the grid on screen is kept up to date by its controller), and a reload of the page drops them;
//   * a tile with nothing on it holds no bitmap; grids are evicted least-recently-used beyond a byte budget.
import type { NormBox } from '@medlevo/shared';

export const TILE_PX = 512;

/** Something to draw into (a canvas element in the browser; a fake in unit tests). */
export interface TileSurface {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: CanvasRenderingContext2D;
}
export type SurfaceFactory = (w: number, h: number) => TileSurface | null;

export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TileState = 'valid' | 'stale';

export interface Tile {
  /** device rect of the tile inside the page canvas */
  rect: DeviceRect;
  state: TileState;
  /** highlight canvas snapshot (null = nothing there) */
  hl: TileSurface | null;
  /** ink canvas snapshot (null = nothing there) */
  ink: TileSurface | null;
}

export interface GridKey {
  /** the store (document) the page belongs to */
  storeKey: string;
  targetKey: string;
  /** canvas size, transform and paper tone */
  viewKey: string;
  /** the visible-layer set */
  visKey: string;
}

export interface GridGeometry {
  cw: number;
  ch: number;
  /** a page-normalized box → device rect of this grid's canvas (with a little padding) */
  toDevice: (b: NormBox) => DeviceRect;
}

export class TileGrid {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
  readonly tiles: Tile[];
  /** a controller is showing this grid right now (it keeps it current; the cache leaves it alone) */
  live = 0;
  lastUsed = 0;

  constructor(
    readonly key: GridKey,
    readonly geometry: GridGeometry,
  ) {
    this.id = gridId(key);
    this.cols = Math.max(1, Math.ceil(geometry.cw / TILE_PX));
    this.rows = Math.max(1, Math.ceil(geometry.ch / TILE_PX));
    this.tiles = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = c * TILE_PX;
        const y = r * TILE_PX;
        this.tiles.push({ rect: { x, y, w: Math.min(TILE_PX, geometry.cw - x), h: Math.min(TILE_PX, geometry.ch - y) }, state: 'stale', hl: null, ink: null });
      }
    }
  }

  /** indexes of the tiles a device rect touches */
  tilesIn(r: DeviceRect): number[] {
    const c0 = Math.max(0, Math.floor(r.x / TILE_PX));
    const c1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / TILE_PX));
    const r0 = Math.max(0, Math.floor(r.y / TILE_PX));
    const r1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / TILE_PX));
    const out: number[] = [];
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) out.push(row * this.cols + col);
    return out;
  }

  get validCount(): number {
    return this.tiles.reduce((n, t) => n + (t.state === 'valid' ? 1 : 0), 0);
  }

  bytes(): number {
    let b = 0;
    for (const t of this.tiles) {
      if (t.hl) b += t.hl.canvas.width * t.hl.canvas.height * 4;
      if (t.ink) b += t.ink.canvas.width * t.ink.canvas.height * 4;
    }
    return b;
  }

  /** mark the tiles a set of page boxes touches stale (or every tile) */
  markStale(boxes: readonly NormBox[] | 'all'): void {
    if (boxes === 'all') {
      for (const t of this.tiles) t.state = 'stale';
      return;
    }
    for (const b of boxes) for (const i of this.tilesIn(this.geometry.toDevice(b))) this.tiles[i]!.state = 'stale';
  }

  release(): void {
    for (const t of this.tiles) {
      t.hl = null;
      t.ink = null;
      t.state = 'stale';
    }
  }
}

export function gridId(k: GridKey): string {
  return `${k.storeKey}\u0001${k.targetKey}\u0001${k.viewKey}\u0001${k.visKey}`;
}

export interface TileCacheStats {
  grids: number;
  bytes: number;
  validTiles: number;
}

/**
 * The cache: grids by key, LRU by bytes. Pure bookkeeping plus snapshot copies; the drawing of strokes stays in the
 * layer controller (./renderer.ts drives it).
 */
export class InkTileCache {
  private grids = new Map<string, TileGrid>();
  private clock = 0;
  /** a fixed budget, or a function read at each eviction (display mode and device memory can change) */
  budgetBytes: number | (() => number);

  constructor(
    private readonly createSurface: SurfaceFactory,
    opts: { budgetBytes?: number | (() => number) } = {},
  ) {
    this.budgetBytes = opts.budgetBytes ?? 96 * 1024 * 1024;
  }

  private budget(): number {
    return typeof this.budgetBytes === 'function' ? this.budgetBytes() : this.budgetBytes;
  }

  /** The grid for this key (created empty — every tile stale — when it is new or its geometry changed). */
  grid(key: GridKey, geometry: GridGeometry): TileGrid {
    const id = gridId(key);
    let g = this.grids.get(id);
    if (g && (g.geometry.cw !== geometry.cw || g.geometry.ch !== geometry.ch)) {
      g.release();
      this.grids.delete(id);
      g = undefined;
    }
    if (!g) {
      g = new TileGrid(key, geometry);
      this.grids.set(id, g);
    }
    g.lastUsed = ++this.clock;
    return g;
  }

  peek(key: GridKey): TileGrid | undefined {
    return this.grids.get(gridId(key));
  }

  /** The page's items changed (`boxes`), or it was reloaded ('all'): grids not on screen go stale there / are dropped. */
  pageChanged(storeKey: string, targetKey: string, boxes: readonly NormBox[] | 'all'): void {
    for (const [id, g] of this.grids) {
      if (g.key.storeKey !== storeKey || g.key.targetKey !== targetKey || g.live > 0) continue;
      if (boxes === 'all') {
        g.release();
        this.grids.delete(id);
      } else g.markStale(boxes);
    }
  }

  /** Copies a region of the page canvases into the tiles it touches (only tiles fully valid stay valid). */
  snapshot(grid: TileGrid, index: number, from: { hl: CanvasImageSource; ink: CanvasImageSource }, has: { hl: boolean; ink: boolean }): void {
    const t = grid.tiles[index]!;
    t.hl = has.hl ? this.copy(t.hl, from.hl, t.rect) : null;
    t.ink = has.ink ? this.copy(t.ink, from.ink, t.rect) : null;
    t.state = 'valid';
  }

  /**
   * Cleared surfaces to draw a cold tile into (the tile itself is the target: the page canvases are only written when
   * it is complete). `has` says which of the two kinds the tile will hold; the other is released.
   */
  prepare(tile: Tile, has: { hl: boolean; ink: boolean }): { hl: TileSurface | null; ink: TileSurface | null } {
    const { w, h } = tile.rect;
    const take = (cur: TileSurface | null, want: boolean): TileSurface | null => {
      if (!want) return null;
      const s = this.surfaceFor(cur, w, h);
      s?.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s?.ctx.clearRect(0, 0, w, h);
      return s;
    };
    tile.hl = take(tile.hl, has.hl);
    tile.ink = take(tile.ink, has.ink);
    return { hl: tile.hl, ink: tile.ink };
  }

  /** Refreshes the part of valid tiles a repainted device rect covers (the rest of each tile was already right). */
  refresh(grid: TileGrid, rect: DeviceRect, from: { hl: CanvasImageSource; ink: CanvasImageSource }): void {
    for (const i of grid.tilesIn(rect)) {
      const t = grid.tiles[i]!;
      if (t.state !== 'valid') continue;
      const x = Math.max(rect.x, t.rect.x);
      const y = Math.max(rect.y, t.rect.y);
      const w = Math.min(rect.x + rect.w, t.rect.x + t.rect.w) - x;
      const h = Math.min(rect.y + rect.h, t.rect.y + t.rect.h) - y;
      if (w <= 0 || h <= 0) continue;
      // a tile that had nothing may have something now (and the reverse): keep a surface for both kinds
      t.hl = this.copyPart(t.hl, from.hl, t.rect, { x, y, w, h });
      t.ink = this.copyPart(t.ink, from.ink, t.rect, { x, y, w, h });
    }
  }

  /** Draws a valid tile onto the page canvases. */
  blit(tile: Tile, to: { hl: CanvasRenderingContext2D; ink: CanvasRenderingContext2D }): void {
    const { x, y, w, h } = tile.rect;
    to.hl.clearRect(x, y, w, h);
    to.ink.clearRect(x, y, w, h);
    if (tile.hl) to.hl.drawImage(tile.hl.canvas, 0, 0, w, h, x, y, w, h);
    if (tile.ink) to.ink.drawImage(tile.ink.canvas, 0, 0, w, h, x, y, w, h);
  }

  /** Grids over budget go, least recently used first; grids on screen stay. */
  evict(): void {
    let total = 0;
    const all = [...this.grids.values()];
    for (const g of all) total += g.bytes();
    const budget = this.budget();
    if (total <= budget) return;
    for (const g of all.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= budget) break;
      if (g.live > 0) continue;
      total -= g.bytes();
      g.release();
      this.grids.delete(g.id);
    }
  }

  dropAll(): void {
    for (const g of this.grids.values()) g.release();
    this.grids.clear();
  }

  stats(): TileCacheStats {
    let bytes = 0;
    let validTiles = 0;
    for (const g of this.grids.values()) {
      bytes += g.bytes();
      validTiles += g.validCount;
    }
    return { grids: this.grids.size, bytes, validTiles };
  }

  private surfaceFor(cur: TileSurface | null, w: number, h: number): TileSurface | null {
    if (cur && cur.canvas.width === w && cur.canvas.height === h) return cur;
    return this.createSurface(w, h);
  }

  private copy(cur: TileSurface | null, src: CanvasImageSource, r: DeviceRect): TileSurface | null {
    const s = this.surfaceFor(cur, r.w, r.h);
    if (!s) return null;
    s.ctx.clearRect(0, 0, r.w, r.h);
    s.ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return s;
  }

  private copyPart(cur: TileSurface | null, src: CanvasImageSource, tile: DeviceRect, part: DeviceRect): TileSurface | null {
    const s = this.surfaceFor(cur, tile.w, tile.h);
    if (!s) return null;
    const dx = part.x - tile.x;
    const dy = part.y - tile.y;
    s.ctx.clearRect(dx, dy, part.w, part.h);
    s.ctx.drawImage(src, part.x, part.y, part.w, part.h, dx, dy, part.w, part.h);
    return s;
  }
}
