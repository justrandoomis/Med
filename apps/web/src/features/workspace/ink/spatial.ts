// Uniform-grid spatial index over normalized page space. Keeps eraser / lasso / tap hit-tests and
// dirty-rect redraws proportional to what is near the pointer, not to the number of strokes on the
// page (spec §55: thousands of notes must stay responsive).
import type { NormBox } from '@medlevo/shared';

const CELLS = 24; // per page unit
const MIN_CELL = -CELLS; // items may overhang the page edge a little
const MAX_CELL = 2 * CELLS;

function cellRange(v0: number, v1: number): [number, number] {
  const a = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(v0 * CELLS)));
  const b = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(v1 * CELLS)));
  return [a, b];
}

function key(cx: number, cy: number): number {
  return (cx + 1024) * 4096 + (cy + 1024);
}

export function boxesOverlap(a: NormBox, b: NormBox): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export class SpatialGrid {
  private cells = new Map<number, Set<string>>();
  private boxes = new Map<string, NormBox>();

  get size(): number {
    return this.boxes.size;
  }

  box(id: string): NormBox | undefined {
    return this.boxes.get(id);
  }

  insert(id: string, b: NormBox): void {
    if (this.boxes.has(id)) this.remove(id);
    this.boxes.set(id, b);
    const [x0, x1] = cellRange(b.x, b.x + b.w);
    const [y0, y1] = cellRange(b.y, b.y + b.h);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        let set = this.cells.get(k);
        if (!set) this.cells.set(k, (set = new Set()));
        set.add(id);
      }
    }
  }

  remove(id: string): void {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    const [x0, x1] = cellRange(b.x, b.x + b.w);
    const [y0, y1] = cellRange(b.y, b.y + b.h);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        const set = this.cells.get(k);
        if (!set) continue;
        set.delete(id);
        if (set.size === 0) this.cells.delete(k);
      }
    }
  }

  /** Ids whose box overlaps `q`. */
  query(q: NormBox): string[] {
    const [x0, x1] = cellRange(q.x, q.x + q.w);
    const [y0, y1] = cellRange(q.y, q.y + q.h);
    const seen = new Set<string>();
    const out: string[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const set = this.cells.get(key(cx, cy));
        if (!set) continue;
        for (const id of set) {
          if (seen.has(id)) continue;
          seen.add(id);
          const b = this.boxes.get(id);
          if (b && boxesOverlap(b, q)) out.push(id);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.boxes.clear();
  }
}
