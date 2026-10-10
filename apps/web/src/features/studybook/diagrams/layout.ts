// Layout and keyboard model of the interactive study diagrams (§31, track F3) — pure functions, unit-tested.
//  * flowchart: layered top-down by the longest path from the starting steps (a cycle never loops forever), the order
//    inside a layer follows the model's order; the first branch is at the reading START (right in RTL);
//  * timeline: one column ordered by `order`;
//  * keyboard: one roving tab stop — ↓ to the first next step, ↑ to the first previous step, ←/→ to the neighbour in
//    the same layer (RTL-aware: «next» is ← in Arabic), Home / End.
//  * text twin: every relation is stated in WORDS, «من «A» إلى «B»» — a bare arrow glyph inside RTL text can be
//    displayed pointing the wrong way (AC-08).
import { DIAGRAM_NODE_KIND_LABELS_AR, type StudyDiagramEdgeView, type StudyDiagramNodeView } from '@medlevo/shared';

export interface PlacedDiagramNode {
  key: string;
  layer: number;
  /** position inside its layer (0 = reading start) */
  slot: number;
  /** physical centre, % of the width (RTL already applied) */
  xPct: number;
  /** top of the node box in px */
  yPx: number;
}

export interface DiagramLayout {
  nodes: Map<string, PlacedDiagramNode>;
  layers: string[][];
  heightPx: number;
}

export const ROW_PX = 112;
export const NODE_H_PX = 64;

/** Longest-path layering (cycles are cut: a node is pushed down at most n times). */
export function layerOf(nodes: Pick<StudyDiagramNodeView, 'key'>[], edges: Pick<StudyDiagramEdgeView, 'from' | 'to'>[]): Map<string, number> {
  const keys = nodes.map((n) => n.key);
  const known = new Set(keys);
  const layer = new Map(keys.map((k) => [k, 0]));
  const valid = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const e of valid) {
      const want = layer.get(e.from)! + 1;
      if (want > layer.get(e.to)! && want < keys.length) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

export function layoutDiagram(kind: 'flowchart' | 'timeline', nodes: StudyDiagramNodeView[], edges: StudyDiagramEdgeView[], rtl: boolean): DiagramLayout {
  const layers: string[][] = [];
  if (kind === 'timeline') {
    [...nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((n) => layers.push([n.key]));
  } else {
    const lay = layerOf(nodes, edges);
    for (const n of nodes) {
      const l = lay.get(n.key) ?? 0;
      (layers[l] ??= []).push(n.key);
    }
  }
  const compact = layers.filter((l) => l && l.length > 0);
  const placed = new Map<string, PlacedDiagramNode>();
  compact.forEach((row, li) => {
    row.forEach((key, si) => {
      const logical = ((si + 1) / (row.length + 1)) * 100;
      placed.set(key, { key, layer: li, slot: si, xPct: rtl ? 100 - logical : logical, yPx: li * ROW_PX + 8 });
    });
  });
  return { nodes: placed, layers: compact, heightPx: compact.length * ROW_PX };
}

export type DiagramMove = 'next' | 'prev' | 'forward' | 'back' | 'home' | 'end';

/** Arrow keys → move (RTL-aware), or null for other keys. */
export function moveForKey(key: string, rtl: boolean): DiagramMove | null {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'ArrowLeft':
      return rtl ? 'forward' : 'back';
    case 'ArrowRight':
      return rtl ? 'back' : 'forward';
    case 'Home':
      return 'home';
    case 'End':
      return 'end';
    default:
      return null;
  }
}

/** The node the focus moves to (stays put at the edges). */
export function moveFocus(layout: DiagramLayout, edges: Pick<StudyDiagramEdgeView, 'from' | 'to'>[], current: string, move: DiagramMove): string {
  const all = layout.layers.flat();
  const here = layout.nodes.get(current);
  if (!here) return all[0] ?? current;
  if (move === 'home') return all[0] ?? current;
  if (move === 'end') return all[all.length - 1] ?? current;
  if (move === 'forward' || move === 'back') {
    const row = layout.layers[here.layer]!;
    const i = here.slot + (move === 'forward' ? 1 : -1);
    return row[i] ?? current;
  }
  const linked = edges.filter((e) => (move === 'next' ? e.from === current : e.to === current)).map((e) => (move === 'next' ? e.to : e.from));
  if (linked.length) return linked[0]!;
  // no relation that way: the first node of the next / previous layer (timelines and loose steps)
  const row = layout.layers[here.layer + (move === 'next' ? 1 : -1)];
  return row?.[0] ?? current;
}

/** Accessible name of a node: kind, label, verification in words, number of relations. */
export function nodeName(n: StudyDiagramNodeView, edges: StudyDiagramEdgeView[]): string {
  const out = edges.filter((e) => e.from === n.key).length;
  const inn = edges.filter((e) => e.to === n.key).length;
  const parts = [`${DIAGRAM_NODE_KIND_LABELS_AR[n.kind]}: ${n.label}`];
  if (n.time_label) parts.push(`الوقت: ${n.time_label}`);
  parts.push(n.verification === 'linked' ? 'مرتبط بدليل' : 'يحتاج مراجعة');
  if (out || inn) parts.push(`${inn} قبلها، ${out} بعدها`);
  return parts.join('، ');
}

/** A relation in words, direction explicit: «من «A» إلى «B» — الشرط: …». */
export function edgeSentence(e: StudyDiagramEdgeView, label: (key: string) => string): string {
  return `من «${label(e.from)}» إلى «${label(e.to)}»${e.label ? ` — الشرط: ${e.label}` : ''}`;
}
