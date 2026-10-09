// Table detection.
//  * RULED tables: horizontal/vertical ruling lines from the PDF operator list form a grid; a missing
//    inner separator inside a row/column means a merged cell (colspan/rowspan). Header rows are rows
//    whose text is bold, or a top row merged across all columns (a title row).
//  * ALIGNED (borderless) tables: ≥ 3 consecutive rows of short segments whose left (or, for RTL, right)
//    edges align on the same column anchors. Conservative: long text lines (two-column prose) never qualify.
// Cell text is verbatim (units, signs and thresholds preserved: "> 10 ×10⁹/L", "≥ 37.3 °C").
import { decideDir, joinLines, logicalLineText } from './lines';
import type { Box, Rule, Segment, TableCellOut, TableOut } from './types';
import { boxOf, cx, cy, median, overlap1d } from './types';

const TOL = 2;

function clusterValues(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1]! <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((c) => c.reduce((s, x) => s + x, 0) / c.length);
}

/** merge collinear, touching/overlapping rules */
export function mergeRules(rules: Rule[]): Rule[] {
  const out: Rule[] = [];
  for (const o of ['h', 'v'] as const) {
    const list = rules
      .filter((r) => r.orientation === o)
      .sort((a, b) => (o === 'h' ? a.top - b.top || a.x0 - b.x0 : a.x0 - b.x0 || a.top - b.top));
    const merged: Rule[] = [];
    for (const r of list) {
      const m = merged.find((x) =>
        o === 'h'
          ? Math.abs(x.top - r.top) <= TOL && r.x0 <= x.x1 + TOL && r.x1 >= x.x0 - TOL
          : Math.abs(x.x0 - r.x0) <= TOL && r.top <= x.bottom + TOL && r.bottom >= x.top - TOL,
      );
      if (m) {
        m.x0 = Math.min(m.x0, r.x0);
        m.x1 = Math.max(m.x1, r.x1);
        m.top = Math.min(m.top, r.top);
        m.bottom = Math.max(m.bottom, r.bottom);
      } else merged.push({ ...r });
    }
    out.push(...merged);
  }
  return out;
}

function intersects(h: Rule, v: Rule): boolean {
  return v.x0 >= h.x0 - TOL && v.x0 <= h.x1 + TOL && h.top >= v.top - TOL && h.top <= v.bottom + TOL;
}

/** Connected groups of rules that form a table frame. */
function ruleGroups(rules: Rule[]): Rule[][] {
  const parent = rules.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (a.orientation !== b.orientation) {
        if (intersects(a.orientation === 'h' ? a : b, a.orientation === 'h' ? b : a)) union(i, j);
      } else if (a.orientation === 'h') {
        // stacked horizontal rules with the same extent (booktabs-style tables without verticals)
        const sameExtent = Math.abs(a.x0 - b.x0) <= 4 && Math.abs(a.x1 - b.x1) <= 4;
        if (sameExtent && Math.abs(a.top - b.top) <= 60) union(i, j);
      }
    }
  }
  const groups = new Map<number, Rule[]>();
  rules.forEach((r, i) => {
    const k = find(i);
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  });
  return [...groups.values()];
}

export interface TableContext {
  /** page text margins used for direction decisions inside cells */
  pageWidth: number;
}

function cellText(segs: Segment[], cell: Box, pageWidth: number): string {
  if (segs.length === 0) return '';
  const dir = decideDir(segs, cell.x0, cell.x1, Math.max(4, pageWidth * 0.01));
  const rows = new Map<number, Segment[]>();
  for (const s of segs) rows.set(s.rowId, [...(rows.get(s.rowId) ?? []), s]);
  const lines = [...rows.values()]
    .sort((a, b) => a[0]!.top - b[0]!.top)
    .map((rowSegs) => logicalLineText(rowSegs.flatMap((s) => s.items).sort((a, b) => a.x0 - b.x0), dir));
  return joinLines(lines);
}

function buildCells(
  ys: number[],
  xs: number[],
  hCovered: (y: number, x0: number, x1: number) => boolean,
  vCovered: (x: number, y0: number, y1: number) => boolean,
): Array<{ r: number; c: number; rowspan: number; colspan: number }> {
  const R = ys.length - 1;
  const C = xs.length - 1;
  const idx = (r: number, c: number) => r * C + c;
  const parent = Array.from({ length: R * C }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (c + 1 < C && !vCovered(xs[c + 1]!, ys[r]!, ys[r + 1]!)) union(idx(r, c), idx(r, c + 1));
      if (r + 1 < R && !hCovered(ys[r + 1]!, xs[c]!, xs[c + 1]!)) union(idx(r, c), idx(r + 1, c));
    }
  }
  const groups = new Map<number, Array<[number, number]>>();
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const k = find(idx(r, c));
    groups.set(k, [...(groups.get(k) ?? []), [r, c]]);
  }
  const cells: Array<{ r: number; c: number; rowspan: number; colspan: number }> = [];
  for (const slots of groups.values()) {
    const rs = slots.map((s) => s[0]);
    const cs = slots.map((s) => s[1]);
    const r = Math.min(...rs);
    const c = Math.min(...cs);
    cells.push({ r, c, rowspan: Math.max(...rs) - r + 1, colspan: Math.max(...cs) - c + 1 });
  }
  return cells.sort((a, b) => a.r - b.r || a.c - b.c);
}

function markHeaders(cells: TableCellOut[], segsByCell: Map<TableCellOut, Segment[]>, cols: number): void {
  const rows = [...new Set(cells.map((c) => c.r))].sort((a, b) => a - b);
  for (const r of rows) {
    const rowCells = cells.filter((c) => c.r === r && c.text.trim());
    if (rowCells.length === 0) break;
    const allBold = rowCells.every((c) => {
      const segs = segsByCell.get(c) ?? [];
      return segs.length > 0 && segs.every((s) => s.bold);
    });
    const titleRow = r === rows[0] && rowCells.length === 1 && rowCells[0]!.colspan === cols && cols > 1;
    if (allBold || titleRow) for (const c of cells.filter((x) => x.r === r)) c.header = true;
    else break;
  }
}

/** Ruled tables. Returns the tables and the ids of the segments they consumed. */
export function detectRuledTables(rulesIn: Rule[], segments: Segment[], ctx: TableContext): { tables: TableOut[]; used: Set<number> } {
  const rules = mergeRules(rulesIn);
  const tables: TableOut[] = [];
  const used = new Set<number>();
  for (const group of ruleGroups(rules)) {
    const hs = group.filter((r) => r.orientation === 'h');
    const vs = group.filter((r) => r.orientation === 'v');
    if (hs.length < 2) continue;
    const frame = boxOf(group.map((r) => ({ x0: r.x0, top: r.top, x1: r.x1, bottom: r.bottom })));
    if (frame.x1 - frame.x0 < 40 || frame.bottom - frame.top < 12) continue;
    let ys = clusterValues(hs.map((h) => h.top), TOL);
    // drop near-duplicate boundaries (double rules)
    ys = ys.filter((y, i) => i === 0 || y - ys[i - 1]! >= 3);
    if (ys.length < 2) continue;
    if (ys[0]! > frame.top + TOL) ys.unshift(frame.top);
    if (ys[ys.length - 1]! < frame.bottom - TOL) ys.push(frame.bottom);
    const inside = segments.filter((s) => !used.has(s.id) && cx(s) >= frame.x0 - 1 && cx(s) <= frame.x1 + 1 && cy(s) >= frame.top - 1 && cy(s) <= frame.bottom + 1);
    if (inside.length < 2) continue;

    let xs = clusterValues(vs.map((v) => v.x0), TOL);
    const verticalsKnown = xs.length >= 2;
    if (!verticalsKnown) {
      // columns from text anchors (left edges) inside the frame
      const anchors = clusterValues(inside.map((s) => s.x0), Math.max(4, median(inside.map((s) => s.size)) * 0.8));
      if (anchors.length < 2) continue;
      xs = [frame.x0, ...anchors.slice(1).map((a) => a - 2), frame.x1];
    } else {
      if (xs[0]! > frame.x0 + TOL) xs.unshift(frame.x0);
      if (xs[xs.length - 1]! < frame.x1 - TOL) xs.push(frame.x1);
    }
    const R = ys.length - 1;
    const C = xs.length - 1;
    if (R * C < 2) continue;

    const hCovered = (y: number, x0: number, x1: number) =>
      hs.some((h) => Math.abs(h.top - y) <= TOL + 1 && overlap1d(h.x0, h.x1, x0, x1) >= 0.6 * (x1 - x0));
    const vCovered = (x: number, y0: number, y1: number) =>
      verticalsKnown ? vs.some((v) => Math.abs(v.x0 - x) <= TOL + 1 && overlap1d(v.top, v.bottom, y0, y1) >= 0.6 * (y1 - y0)) : true;
    const grid = buildCells(ys, xs, hCovered, vCovered);
    const cells: TableCellOut[] = [];
    const segsByCell = new Map<TableCellOut, Segment[]>();
    for (const g of grid) {
      const box: Box = { x0: xs[g.c]!, top: ys[g.r]!, x1: xs[g.c + g.colspan]!, bottom: ys[g.r + g.rowspan]! };
      const segs = inside.filter((s) => cx(s) >= box.x0 && cx(s) < box.x1 && cy(s) >= box.top && cy(s) < box.bottom);
      const cell: TableCellOut = { r: g.r, c: g.c, rowspan: g.rowspan, colspan: g.colspan, header: false, text: cellText(segs, box, ctx.pageWidth), box };
      cells.push(cell);
      segsByCell.set(cell, segs);
    }
    const filled = cells.filter((c) => c.text.trim()).length;
    if (filled < 2) continue;
    markHeaders(cells, segsByCell, C);
    for (const s of inside) used.add(s.id);
    tables.push({ box: frame, rows: R, cols: C, cells, method: 'ruled' });
  }
  return { tables, used };
}

/** Borderless tables from aligned short segments. */
export function detectAlignedTables(segments: Segment[], ctx: TableContext): { tables: TableOut[]; used: Set<number> } {
  const used = new Set<number>();
  const tables: TableOut[] = [];
  const byRow = new Map<number, Segment[]>();
  for (const s of segments) byRow.set(s.rowId, [...(byRow.get(s.rowId) ?? []), s]);
  const rows = [...byRow.values()].map((r) => r.sort((a, b) => a.x0 - b.x0)).sort((a, b) => a[0]!.top - b[0]!.top);

  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.length < 2) {
      i++;
      continue;
    }
    // grow a run of multi-segment rows with small vertical gaps
    let j = i;
    while (
      j + 1 < rows.length &&
      rows[j + 1]!.length >= 2 &&
      rows[j + 1]![0]!.top - Math.max(...rows[j]!.map((s) => s.bottom)) <= 2.5 * median(rows[j]!.map((s) => s.size))
    ) j++;
    const run = rows.slice(i, j + 1);
    i = j + 1;
    if (run.length < 3) continue;
    const segs = run.flat();
    const size = median(segs.map((s) => s.size)) || 10;
    const avgChars = segs.reduce((n, s) => n + s.chars, 0) / segs.length;
    if (avgChars > 28) continue; // prose lines (e.g. two text columns sharing baselines) are not tables
    const rtl = segs.reduce((n, s) => n + s.r, 0) > segs.reduce((n, s) => n + s.l, 0);
    const edge = (s: Segment) => (rtl ? s.x1 : s.x0);
    const anchors = clusterValues(segs.map(edge), Math.max(4, size * 0.8));
    if (anchors.length < 2) continue;
    const anchorOf = (s: Segment) => anchors.findIndex((a) => Math.abs(edge(s) - a) <= Math.max(4, size * 0.8) + 0.5);
    if (!segs.every((s) => anchorOf(s) >= 0)) continue;
    // each anchor must be used by at least half of the rows
    const usage = anchors.map((_, k) => run.filter((row) => row.some((s) => anchorOf(s) === k)).length);
    if (usage.some((u) => u < run.length * 0.5)) continue;
    const order = rtl ? [...anchors.keys()].reverse() : [...anchors.keys()];
    const colOf = (s: Segment) => order.indexOf(anchorOf(s));
    const C = anchors.length;
    const cells: TableCellOut[] = [];
    const segsByCell = new Map<TableCellOut, Segment[]>();
    run.forEach((row, r) => {
      for (let c = 0; c < C; c++) {
        const inCell = row.filter((s) => colOf(s) === c);
        const box = inCell.length ? boxOf(inCell) : { x0: 0, top: row[0]!.top, x1: 0, bottom: row[0]!.bottom };
        const cell: TableCellOut = { r, c, rowspan: 1, colspan: 1, header: false, text: cellText(inCell, box, ctx.pageWidth), box };
        cells.push(cell);
        segsByCell.set(cell, inCell);
      }
    });
    markHeaders(cells, segsByCell, C);
    for (const s of segs) used.add(s.id);
    tables.push({ box: boxOf(segs), rows: run.length, cols: C, cells, method: 'aligned' });
  }
  return { tables, used };
}

/**
 * Plain-text serialization with header context, used for the table region text and its chunk:
 * title rows verbatim, then each data row as "Header: value | Header: value".
 */
export function serializeTable(t: Pick<TableOut, 'rows' | 'cols' | 'cells'>, caption?: string | null): string {
  const lines: string[] = [];
  if (caption) lines.push(caption);
  const headerRows = [...new Set(t.cells.filter((c) => c.header).map((c) => c.r))].sort((a, b) => a - b);
  // column header labels: the last header row that is not a single merged title cell
  const colHeaders: string[] = Array(t.cols).fill('');
  for (const r of headerRows) {
    const rowCells = t.cells.filter((c) => c.r === r);
    const isTitle = rowCells.length === 1 && rowCells[0]!.colspan === t.cols && t.cols > 1;
    if (isTitle) {
      lines.push(rowCells[0]!.text);
      continue;
    }
    for (const c of rowCells) for (let k = c.c; k < c.c + c.colspan; k++) colHeaders[k] = c.text;
  }
  const hasHeaders = colHeaders.some((h) => h);
  if (hasHeaders) lines.push(colHeaders.map((h) => h || '—').join(' | '));
  for (let r = 0; r < t.rows; r++) {
    if (headerRows.includes(r)) continue;
    const rowCells = t.cells.filter((c) => c.r === r).sort((a, b) => a.c - b.c);
    if (!rowCells.some((c) => c.text.trim())) continue;
    lines.push(
      rowCells
        .map((c) => (hasHeaders && colHeaders[c.c] ? `${colHeaders[c.c]}: ${c.text || '—'}` : c.text || '—'))
        .join(' | '),
    );
  }
  return lines.join('\n');
}
