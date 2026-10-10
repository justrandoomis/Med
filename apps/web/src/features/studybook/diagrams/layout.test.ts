// Layout + keyboard model of the interactive study diagrams (§31, track F3): longest-path layers that never loop on a
// cycle, timelines ordered by `order`, RTL placement (first branch at the reading start), RTL-aware arrow keys, and the
// relation sentence that states the direction in words (AC-08).
import { describe, expect, it } from 'vitest';
import type { StudyDiagramEdgeView, StudyDiagramNodeView } from '@medlevo/shared';
import { edgeSentence, layerOf, layoutDiagram, moveFocus, moveForKey, nodeName, ROW_PX } from './layout';

const node = (key: string, over: Partial<StudyDiagramNodeView> = {}): StudyDiagramNodeView => ({
  key,
  label: `Step ${key}`,
  kind: 'step',
  order: null,
  time_label: null,
  statement: `Statement ${key}.`,
  claim_ids: [],
  verification: 'linked',
  ...over,
});
const edge = (from: string, to: string, label: string | null = null): StudyDiagramEdgeView => ({ from, to, label, statement: `${from} leads to ${to}.`, claim_ids: [], verification: 'linked' });

// N1 → N2 (decision) → N3 (yes) / N4 (no) → N5
const nodes = [node('N1', { kind: 'start' }), node('N2', { kind: 'decision' }), node('N3'), node('N4'), node('N5', { kind: 'outcome' })];
const edges = [edge('N1', 'N2'), edge('N2', 'N3', 'score ≥ 7'), edge('N2', 'N4', 'score < 7'), edge('N3', 'N5'), edge('N4', 'N5')];

describe('diagram layout', () => {
  it('layers a flowchart by the longest path and survives a cycle', () => {
    const l = layerOf(nodes, edges);
    expect(Object.fromEntries(l)).toEqual({ N1: 0, N2: 1, N3: 2, N4: 2, N5: 3 });
    const cyc = layerOf([node('A'), node('B'), node('C')], [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')]);
    for (const v of cyc.values()) expect(v).toBeLessThan(3);
    // edges to unknown nodes and self loops are ignored
    expect(Object.fromEntries(layerOf([node('A')], [edge('A', 'A'), edge('A', 'Z')]))).toEqual({ A: 0 });
  });

  it('places the first branch at the reading start (right in RTL) and sizes the canvas by layer', () => {
    const rtl = layoutDiagram('flowchart', nodes, edges, true);
    const ltr = layoutDiagram('flowchart', nodes, edges, false);
    expect(rtl.layers).toEqual([['N1'], ['N2'], ['N3', 'N4'], ['N5']]);
    expect(rtl.heightPx).toBe(4 * ROW_PX);
    expect(rtl.nodes.get('N3')!.xPct).toBeGreaterThan(rtl.nodes.get('N4')!.xPct);
    expect(ltr.nodes.get('N3')!.xPct).toBeLessThan(ltr.nodes.get('N4')!.xPct);
    expect(rtl.nodes.get('N1')!.xPct).toBe(50);
  });

  it('a timeline is one column in `order`, whatever the model order', () => {
    const t = layoutDiagram('timeline', [node('N2', { order: 2 }), node('N3', { order: 3 }), node('N1', { order: 1 })], [], true);
    expect(t.layers).toEqual([['N1'], ['N2'], ['N3']]);
    expect(t.nodes.get('N3')!.yPx).toBeGreaterThan(t.nodes.get('N1')!.yPx);
  });

  it('arrow keys move along relations and inside a layer, RTL-aware; the focus stays put at the edges', () => {
    const l = layoutDiagram('flowchart', nodes, edges, true);
    expect(moveForKey('ArrowDown', true)).toBe('next');
    expect(moveForKey('ArrowLeft', true)).toBe('forward');
    expect(moveForKey('ArrowLeft', false)).toBe('back');
    expect(moveForKey('ArrowRight', true)).toBe('back');
    expect(moveForKey('a', true)).toBeNull();
    expect(moveFocus(l, edges, 'N1', 'next')).toBe('N2');
    expect(moveFocus(l, edges, 'N2', 'next')).toBe('N3');
    expect(moveFocus(l, edges, 'N3', 'forward')).toBe('N4');
    expect(moveFocus(l, edges, 'N4', 'forward')).toBe('N4');
    expect(moveFocus(l, edges, 'N4', 'back')).toBe('N3');
    expect(moveFocus(l, edges, 'N5', 'prev')).toBe('N3');
    expect(moveFocus(l, edges, 'N1', 'prev')).toBe('N1');
    expect(moveFocus(l, edges, 'N3', 'home')).toBe('N1');
    expect(moveFocus(l, edges, 'N1', 'end')).toBe('N5');
    // a timeline without edges: next / previous layer
    const t = layoutDiagram('timeline', [node('A', { order: 1 }), node('B', { order: 2 })], [], true);
    expect(moveFocus(t, [], 'A', 'next')).toBe('B');
    expect(moveFocus(t, [], 'B', 'prev')).toBe('A');
  });

  it('names a node with its kind, time, verification in words and relation counts; states a relation’s direction in words', () => {
    expect(nodeName(nodes[1]!, edges)).toBe('قرار: Step N2، مرتبط بدليل، 1 قبلها، 2 بعدها');
    expect(nodeName(node('X', { time_label: 'Day 1', verification: 'needs_review' }), [])).toBe('خطوة: Step X، الوقت: Day 1، يحتاج مراجعة');
    const label = (k: string) => nodes.find((n) => n.key === k)!.label;
    expect(edgeSentence(edges[1]!, label)).toBe('من «Step N2» إلى «Step N3» — الشرط: score ≥ 7');
    expect(edgeSentence(edges[0]!, label)).toBe('من «Step N1» إلى «Step N2»');
  });
});
