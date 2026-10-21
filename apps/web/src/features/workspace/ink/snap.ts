// Snapping and alignment guides (parity N1 wave 2, G22) — pure, unit-tested.
//
// While a selection is dragged (or a shape drawn) its edges and centre snap to: the edges and centres of the other items
// on the page, the paper's grid pitch (a note page's ruled / dotted / grid template), and — on lecture pages — the boxes
// of the processed source regions (lines, paragraphs, figures), so labels and boxes line up with the printed content.
// The targets are collected ONCE when the drag starts (off the pointer path); each move is a binary search. Holding Alt
// turns snapping off for that move; the owner can turn it off (or any of its sources) in «إعدادات الكتابة».
import type { NormBox } from '@medlevo/shared';

export type SnapSource = 'item' | 'grid' | 'region';

/** One snap line: x = const (axis 'x') or y = const (axis 'y'), normalized page units. */
export interface SnapLine {
  axis: 'x' | 'y';
  at: number;
  source: SnapSource;
  /** extent along the other axis (where to draw the guide) */
  from: number;
  to: number;
}

export interface SnapTargets {
  xs: SnapLine[];
  ys: SnapLine[];
  /** (review of N1 wave 2) a source was still loading (the page's processed regions): collect again on the next move */
  partial?: boolean;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapLine[];
}

const sortLines = (a: SnapLine, b: SnapLine) => a.at - b.at;

/**
 * The lines a moving box can snap to. `items` are the other items' boxes (the moving ones left out by the caller);
 * `pitch` the paper's grid pitch (normalized x and y, null = no grid); `regions` processed source regions.
 */
export function buildSnapTargets(opts: { items?: readonly NormBox[]; regions?: readonly NormBox[]; pitch?: { x: number; y: number; y0?: number } | null }): SnapTargets {
  const xs: SnapLine[] = [];
  const ys: SnapLine[] = [];
  const addBox = (b: NormBox, source: SnapSource) => {
    for (const x of [b.x, b.x + b.w / 2, b.x + b.w]) xs.push({ axis: 'x', at: x, source, from: b.y, to: b.y + b.h });
    for (const y of [b.y, b.y + b.h / 2, b.y + b.h]) ys.push({ axis: 'y', at: y, source, from: b.x, to: b.x + b.w });
  };
  for (const b of opts.items ?? []) addBox(b, 'item');
  for (const b of opts.regions ?? []) addBox(b, 'region');
  const p = opts.pitch;
  if (p && p.x > 0.002 && p.y > 0.002) {
    for (let x = 0; x <= 1 + 1e-9; x += p.x) xs.push({ axis: 'x', at: x, source: 'grid', from: 0, to: 1 });
    for (let y = p.y0 ?? 0; y <= 1 + 1e-9; y += p.y) ys.push({ axis: 'y', at: y, source: 'grid', from: 0, to: 1 });
  }
  return { xs: xs.sort(sortLines), ys: ys.sort(sortLines) };
}

/** The line nearest to `v` within `tol` (binary search), or null. Items and regions win over the grid at equal distance. */
export function nearestLine(lines: readonly SnapLine[], v: number, tol: number): SnapLine | null {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.at < v - tol) lo = mid + 1;
    else hi = mid;
  }
  let best: SnapLine | null = null;
  let bestD = Infinity;
  for (let i = lo; i < lines.length && lines[i]!.at <= v + tol; i++) {
    const l = lines[i]!;
    const d = Math.abs(l.at - v) + (l.source === 'grid' ? tol * 0.25 : 0);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

/**
 * Snaps a box moved by (dx, dy): its left / centre / right to the nearest x line and its top / middle / bottom to the
 * nearest y line, each within the tolerance (normalized x and y). Returns the corrected offset and the guides to draw.
 */
export function snapMove(box: NormBox, dx: number, dy: number, t: SnapTargets, tol: { x: number; y: number }): SnapResult {
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  let bestX: { line: SnapLine; shift: number } | null = null;
  for (const x of [moved.x, moved.x + moved.w / 2, moved.x + moved.w]) {
    const line = nearestLine(t.xs, x, tol.x);
    if (line && (!bestX || Math.abs(line.at - x) < Math.abs(bestX.shift))) bestX = { line, shift: line.at - x };
  }
  let bestY: { line: SnapLine; shift: number } | null = null;
  for (const y of [moved.y, moved.y + moved.h / 2, moved.y + moved.h]) {
    const line = nearestLine(t.ys, y, tol.y);
    if (line && (!bestY || Math.abs(line.at - y) < Math.abs(bestY.shift))) bestY = { line, shift: line.at - y };
  }
  const guides: SnapLine[] = [];
  const out = { dx, dy };
  if (bestX) {
    out.dx += bestX.shift;
    const y0 = Math.min(bestX.line.from, moved.y);
    const y1 = Math.max(bestX.line.to, moved.y + moved.h);
    guides.push({ ...bestX.line, from: y0, to: y1 });
  }
  if (bestY) {
    out.dy += bestY.shift;
    const x0 = Math.min(bestY.line.from, moved.x);
    const x1 = Math.max(bestY.line.to, moved.x + moved.w);
    guides.push({ ...bestY.line, from: x0, to: x1 });
  }
  return { ...out, guides };
}

/** Snaps one point (a shape's corner or end being drawn). */
export function snapPoint(p: [number, number], t: SnapTargets, tol: { x: number; y: number }): { at: [number, number]; guides: SnapLine[] } {
  const lx = nearestLine(t.xs, p[0], tol.x);
  const ly = nearestLine(t.ys, p[1], tol.y);
  const at: [number, number] = [lx ? lx.at : p[0], ly ? ly.at : p[1]];
  const guides: SnapLine[] = [];
  if (lx) guides.push({ ...lx, from: Math.min(lx.from, at[1]), to: Math.max(lx.to, at[1]) });
  if (ly) guides.push({ ...ly, from: Math.min(ly.from, at[0]), to: Math.max(ly.to, at[0]) });
  return { at, guides };
}

/**
 * The grid pitch of a note page's paper (normalized), from its template and the paper geometry in page units; null for
 * blank paper or a lecture page.
 */
export function paperPitch(template: string | null | undefined, pageW: number, pageH: number, geometry: { ruled: { pitch: number; top: number }; dotted: { pitch: number }; grid: { pitch: number } }): { x: number; y: number; y0?: number } | null {
  if (template === 'grid' || template === 'dotted') {
    const pt = geometry[template].pitch;
    return { x: pt / pageW, y: pt / pageH };
  }
  if (template === 'ruled') {
    const g = geometry.ruled;
    return { x: g.pitch / pageW, y: g.pitch / pageH, y0: g.top / pageH };
  }
  return null;
}
