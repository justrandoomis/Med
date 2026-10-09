// Stroke eraser and point eraser (spec §26 «Eraser للضربة أو النقطة»).
//
// Point erasing never edits a stroke in place: the touched stroke is tombstoned and the surviving
// runs become NEW strokes with NEW ids (append ops). Undo restores the original stroke (same id)
// and tombstones the pieces, so nothing the owner wrote is ever lost (§47, AC-24).
import type { InkData, InkPoint } from '@medlevo/shared';
import { densify, pointSegDistSq, segSegDistSq, widthAt, type Vec } from './math';
import { isInkStroke, itemGeometry, type InkItem } from './model';

/** Distance test between an item's geometry and the eraser path (iso units). */
export function itemHitByPath(item: InkItem, path: readonly Vec[], radius: number, ar: number): boolean {
  const g = itemGeometry(item, ar);
  const r = radius + g.halfWidth;
  const r2 = r * r;
  const segs = path.length === 1 ? [[path[0]!, path[0]!] as const] : path.slice(1).map((p, i) => [path[i]!, p] as const);
  for (const line of g.lines) {
    if (line.length === 1) {
      for (const [a, b] of segs) if (pointSegDistSq(line[0]!, a, b) <= r2) return true;
      continue;
    }
    for (let i = 1; i < line.length; i++) {
      const c = line[i - 1]!;
      const d = line[i]!;
      for (const [a, b] of segs) if (segSegDistSq(a, b, c, d) <= r2) return true;
    }
  }
  return false;
}

/**
 * Removes the parts of `points` under the eraser path. Returns null when nothing was touched,
 * otherwise the surviving runs (possibly none). Each run is re-timed to start at t = 0.
 *
 * The hit test runs on a densified copy (so the cut follows the eraser, not the sampling rate), but
 * a surviving run keeps only the owner's ORIGINAL samples plus its two cut ends: the pieces carry the
 * real recorded points (time, pressure, tilt) and never grow beyond the original stroke + 2 points
 * per piece (a densified piece of a long stroke could exceed the server's 20 000-point limit).
 */
export function erasePoints(points: readonly InkPoint[], data: Pick<InkData, 'style' | 'pressure_available'>, path: readonly Vec[], radius: number, ar: number): InkPoint[][] | null {
  if (points.length === 0 || path.length === 0) return null;
  const { points: dense, original } = densifyMarked(points, Math.max(radius / 3, 1e-4), ar);
  const segs = path.length === 1 ? [[path[0]!, path[0]!] as const] : path.slice(1).map((p, i) => [path[i]!, p] as const);
  const hit = new Uint8Array(dense.length);
  let any = false;
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i]!;
    const iso: Vec = [p[0], p[1] * ar];
    const r = radius + widthAt(data.style.tool, data.style.width, data.pressure_available, p[3]) / 2;
    const r2 = r * r;
    for (const [a, b] of segs) {
      if (pointSegDistSq(iso, a, b) <= r2) {
        hit[i] = 1;
        any = true;
        break;
      }
    }
  }
  if (!any) return null;
  const runs: InkPoint[][] = [];
  let start = -1;
  for (let i = 0; i <= dense.length; i++) {
    const alive = i < dense.length && !hit[i];
    if (alive && start < 0) start = i;
    else if (!alive && start >= 0) {
      // leftovers of a single sample are dust, not writing the owner made
      if (i - start >= 2) {
        const run: InkPoint[] = [dense[start]!];
        for (let k = start + 1; k < i - 1; k++) if (original[k]) run.push(dense[k]!);
        run.push(dense[i - 1]!);
        runs.push(run);
      }
      start = -1;
    }
  }
  return runs.map(retime);
}

/** densify() that also marks which output points are the input's own samples. */
function densifyMarked(points: readonly InkPoint[], step: number, ar: number): { points: InkPoint[]; original: Uint8Array } {
  const dense = densify(points, step, ar);
  const original = new Uint8Array(dense.length);
  // densify keeps every input point (same object) in order, with interpolated ones in between
  let j = 0;
  for (let i = 0; i < dense.length && j < points.length; i++) {
    if (dense[i] === points[j]) {
      original[i] = 1;
      j++;
    }
  }
  return { points: dense, original };
}

function retime(run: InkPoint[]): InkPoint[] {
  const t0 = run[0]![2];
  return run.map((p) => {
    const q = p.slice() as number[];
    q[2] = Math.max(0, q[2]! - t0);
    return q as unknown as InkPoint;
  });
}

/**
 * One point-eraser gesture. Works on a private copy of the touched strokes; nothing is written
 * until `result()` (pointerup) so a long erase produces one tombstone per original stroke and
 * one append per surviving piece — and a single undo step.
 */
export class PointEraseSession {
  /** original id → current surviving runs */
  readonly pieces = new Map<string, InkPoint[][]>();
  readonly originals = new Map<string, InkItem>();

  constructor(private readonly ar: number) {}

  /** Erase along `path` (iso) on the given candidate items. Returns ids whose rendering changed. */
  apply(candidates: readonly InkItem[], path: readonly Vec[], radius: number): string[] {
    const changed: string[] = [];
    for (const item of candidates) {
      if (!isInkStroke(item) || item.locked) continue;
      const current = this.pieces.get(item.id) ?? [item.data.points.slice()];
      let touched = false;
      const next: InkPoint[][] = [];
      for (const run of current) {
        const res = erasePoints(run, item.data, path, radius, this.ar);
        if (res === null) next.push(run);
        else {
          touched = true;
          next.push(...res);
        }
      }
      if (touched) {
        if (!this.originals.has(item.id)) this.originals.set(item.id, item);
        this.pieces.set(item.id, next);
        changed.push(item.id);
      }
    }
    return changed;
  }

  get touchedCount(): number {
    return this.originals.size;
  }
}
