import { describe, expect, it } from 'vitest';
import { richTextFromPlain, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { fractionInside, pointInPolygon, type Vec } from '../../src/features/workspace/ink/math';
import { lassoSamplePoints, makeInkItem, makeShapeItem, makeStickyItem, makeTextItem, type InkItem } from '../../src/features/workspace/ink/model';
import { SpatialGrid } from '../../src/features/workspace/ink/spatial';
import { itemBBox } from '../../src/features/workspace/ink/model';

const AR = 1.25;
const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NP', space: 'page_norm' };
const style = { tool: 'pen' as const, color: 'ink-black', width: 0.002 };

function hline(id: string, x0: number, x1: number, y: number): InkItem {
  const points: InkPoint[] = Array.from({ length: 30 }, (_, i) => [x0 + ((x1 - x0) * i) / 29, y, i]);
  return makeInkItem({ id, anchor, now: 1, z: 1, style, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
}

/** Same rule as the lasso gesture: strokes/shapes ≥ 50 % inside, text/sticky entirely inside. */
function selectByLasso(items: InkItem[], poly: Vec[]): string[] {
  return items
    .filter((it) => {
      const s = lassoSamplePoints(it, AR);
      return it.kind === 'text' || it.kind === 'sticky' ? s.every((p) => pointInPolygon(p, poly)) : fractionInside(s, poly) >= 0.5;
    })
    .map((i) => i.id);
}

describe('lasso polygon hit-test', () => {
  // a lasso loop around the upper-left quarter (normalized page coordinates)
  const lasso: Vec[] = [
    [0.05, 0.05],
    [0.5, 0.05],
    [0.5, 0.45],
    [0.05, 0.45],
  ];

  it('selects strokes mostly inside, not strokes mostly outside', () => {
    const inside = hline('in', 0.1, 0.4, 0.2);
    const half = hline('half', 0.3, 0.62, 0.3); // ~62 % inside
    const mostlyOut = hline('out', 0.4, 0.95, 0.3); // ~18 % inside
    const far = hline('far', 0.6, 0.9, 0.8);
    expect(selectByLasso([inside, half, mostlyOut, far], lasso)).toEqual(['in', 'half']);
  });

  it('selects shapes, text boxes and sticky notes by their geometry', () => {
    const rect = makeShapeItem({ id: 'rect', anchor, now: 1, z: 1, shape: 'rect', from: [0.1, 0.1], to: [0.3, 0.3], style });
    const text = makeTextItem({ id: 'text', anchor, now: 1, z: 1, box: { x: 0.1, y: 0.35, w: 0.2, h: 0.05 }, text: richTextFromPlain('ملاحظة'), color: 'ink-black', fontScale: 0.02 });
    const textOut = makeTextItem({ id: 'textOut', anchor, now: 1, z: 1, box: { x: 0.4, y: 0.35, w: 0.3, h: 0.05 }, text: richTextFromPlain('خارج'), color: 'ink-black', fontScale: 0.02 });
    const sticky = makeStickyItem({ id: 'sticky', anchor, now: 1, z: 1, at: [0.45, 0.1], text: 'ليش؟', color: 'hl-yellow' });
    expect(selectByLasso([rect, text, textOut, sticky], lasso)).toEqual(['rect', 'text', 'sticky']);
  });

  it('works with a concave, self-crossing lasso', () => {
    const figure8: Vec[] = [
      [0.1, 0.1],
      [0.4, 0.4],
      [0.4, 0.1],
      [0.1, 0.4],
    ];
    // a bow tie: left and right lobes are inside, the wedges above and below the crossing are not
    expect(pointInPolygon([0.15, 0.25], figure8)).toBe(true);
    expect(pointInPolygon([0.35, 0.25], figure8)).toBe(true);
    expect(pointInPolygon([0.25, 0.15], figure8)).toBe(false);
    expect(pointInPolygon([0.25, 0.35], figure8)).toBe(false);
  });
});

describe('spatial index', () => {
  it('returns only items near the query (and stays correct after updates)', () => {
    const grid = new SpatialGrid();
    const items: InkItem[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) / 50;
      const y = Math.floor(i / 50) / 40;
      items.push(hline(`s${i}`, x, x + 0.015, y));
    }
    for (const it of items) grid.insert(it.id, itemBBox(it, AR));
    const q = { x: 0.5, y: 0.5, w: 0.01, h: 0.01 };
    const found = grid.query(q);
    const brute = items.filter((it) => {
      const b = itemBBox(it, AR);
      return b.x <= q.x + q.w && q.x <= b.x + b.w && b.y <= q.y + q.h && q.y <= b.y + b.h;
    });
    expect(new Set(found)).toEqual(new Set(brute.map((b) => b.id)));
    expect(found.length).toBeLessThan(10);
    grid.remove(found[0]!);
    expect(grid.query(q)).not.toContain(found[0]);
    grid.insert('moved', { x: 0.505, y: 0.505, w: 0.001, h: 0.001 });
    expect(grid.query(q)).toContain('moved');
  });
});
