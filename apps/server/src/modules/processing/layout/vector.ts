// Figures DRAWN with PDF path operators (H2 item 1): a flowchart of boxes and arrows, a bar chart, a schematic — no
// picture XObject, so the image-based figure detection never saw them and their labels became ordinary paragraphs.
// A dense group of drawing elements (separate closed shapes, curves, polygons, connector lines with arrowheads) is a
// figure region; its text is the figure's label set (analyzePage), its caption is linked like a picture's.
// Decoration is excluded on purpose: table grids and zebra rows (shapes that share edges), one frame around a paragraph,
// bullets and other glyph-sized marks, full-width header bars and page frames. A drawing that is a figure but not
// clearly a diagram (no arrows / connectors, e.g. filled bars) is `uncertain`. Relations are never read from the
// geometry (AC-08): only a vision reading may propose them.
import type { Box, Drawing, PageGeom, TextItem } from './types';
import { boxOf, overlap1d } from './types';

export interface VectorFigure extends Box {
  /** not clearly a diagram: the figure region is shown as uncertain */
  uncertain: boolean;
}

type Kind = 'shape' | 'line' | 'arrow';
interface El {
  d: Drawing;
  kind: Kind;
}

const CAPTION_RE = /^(?:figure|fig\.?|table|chart|diagram|شكل|الشكل|جدول|الجدول)\s*\(?[0-9٠-٩]/i;

function gap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
  return Math.max(dx, dy);
}

function near(p: [number, number], b: Box, tol: number): boolean {
  return p[0] >= b.x0 - tol && p[0] <= b.x1 + tol && p[1] >= b.top - tol && p[1] <= b.bottom + tol;
}

/** Ends of a straight line element (its box diagonal or its long axis). */
function lineEnds(d: Drawing): Array<[number, number]> {
  return [
    [d.x0, d.top],
    [d.x1, d.bottom],
    [d.x0, d.bottom],
    [d.x1, d.top],
  ];
}

export function detectVectorFigures(drawings: Drawing[], items: TextItem[], geom: PageGeom, exclude: Box[] = []): VectorFigure[] {
  const pageArea = geom.width * geom.height;
  const els: El[] = [];
  const lines: Drawing[] = [];
  const marks: Drawing[] = [];
  for (const d of drawings) {
    const w = d.x1 - d.x0;
    const h = d.bottom - d.top;
    const area = w * h;
    if (area > 0.6 * pageArea) continue; // page frame / background
    if (d.filled && w > 0.85 * geom.width && h < 60) continue; // header / footer bar
    if (Math.max(w, h) < 10) {
      marks.push(d); // arrowhead, bullet, checkbox, glyph decoration — decided below
      continue;
    }
    if (d.closed && w >= 10 && h >= 8) els.push({ d, kind: 'shape' });
    else if (!d.closed || w <= 2.5 || h <= 2.5) lines.push(d);
  }
  // a small closed polygon at the end of a line is an arrowhead; other small marks (bullets, ticks) are not drawings
  for (const m of marks) {
    if (!m.closed || m.axisAligned || m.curved) continue;
    if (lines.some((l) => lineEnds(l).some((p) => near(p, m, 4)))) els.push({ d: m, kind: 'arrow' });
  }
  for (const l of lines) els.push({ d: l, kind: 'line' });
  if (els.length < 3) return [];

  // proximity clusters
  const parent = els.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      if (gap(els[i]!.d, els[j]!.d) <= 12) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const clusters = new Map<number, El[]>();
  els.forEach((e, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), e]));

  const out: VectorFigure[] = [];
  for (const group of clusters.values()) {
    const shapes = group.filter((e) => e.kind === 'shape').map((e) => e.d);
    const arrows = group.filter((e) => e.kind === 'arrow').length;
    const connectors = group.filter((e) => e.kind === 'line').map((e) => e.d);
    // shapes that stand apart (≥ 3 pt from every other shape): boxes of a diagram, bars of a chart — not table cells,
    // zebra rows or nested frames, which share or touch edges
    const separate = shapes.filter((s) => shapes.every((o) => o === s || gap(s, o) >= 3)).length;
    const curvedOrPoly = shapes.filter((s) => s.curved || !s.axisAligned).length;
    const accepted = separate >= 3 || (separate >= 2 && (arrows >= 1 || connectors.length >= 1)) || (curvedOrPoly >= 2 && group.length >= 4);
    if (!accepted) continue;
    let box = boxOf(group.map((e) => e.d));
    if (box.x1 - box.x0 < 40 || box.bottom - box.top < 30 || (box.x1 - box.x0) * (box.bottom - box.top) < 0.015 * pageArea) continue;
    // framed prose is not a figure: long runs of text inside the drawing
    const inside = items.filter((it) => {
      const cx = (it.x0 + it.x1) / 2;
      const cy = (it.top + it.bottom) / 2;
      return cx >= box.x0 && cx <= box.x1 && cy >= box.top && cy <= box.bottom;
    });
    const chars = inside.reduce((n, it) => n + it.text.replace(/\s+/g, '').length, 0);
    if (inside.some((it) => it.text.trim().length >= 50) || chars > 300) continue;
    // a picture already covers it
    const a = (box.x1 - box.x0) * (box.bottom - box.top);
    if (exclude.some((e) => overlap1d(e.x0, e.x1, box.x0, box.x1) * overlap1d(e.top, e.bottom, box.top, box.bottom) >= 0.5 * a)) continue;
    // short labels right next to the drawing (axis labels, an arrow's note) belong to it; captions do not
    const adjacent = items.filter((it) => !inside.includes(it) && it.text.trim().length <= 24 && !CAPTION_RE.test(it.text.trim()) && gap(it, box) <= 14);
    if (adjacent.length) box = boxOf([box, ...adjacent]);
    // clearly a diagram when shapes are joined by arrows or connectors; filled bars / loose shapes stay uncertain
    const clear = separate >= 2 && (arrows >= 1 || (connectors.length >= 1 && curvedOrPoly >= 1));
    out.push({ ...box, uncertain: !clear });
  }
  return out;
}
