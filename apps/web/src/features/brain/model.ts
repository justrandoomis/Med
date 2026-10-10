// Course Brain web — pure helpers (unit-tested): knowledge-map layout and keyboard navigation, neighbours of a node,
// the labels / tones of the knowledge states and coverage statuses (always text + icon in the UI, never colour alone).
import { KNOWLEDGE_STATE_LABELS_AR, type KnowledgeMapEdge, type KnowledgeMapNode, type KnowledgeMapResponse, type KnowledgeState, type CoverageCount } from '@medlevo/shared';

// ───────── knowledge map layout ─────────
export type MapColumn = 0 | 1 | 2;
export const COLUMN_OF: Record<KnowledgeMapNode['type'], MapColumn> = { lecture: 0, concept: 1, question: 2 };
export const COLUMN_TITLES_AR = ['المحاضرات', 'المفاهيم', 'الأسئلة'] as const;
/** Row pitch in px: a 44px target + 12px air. */
export const ROW_PX = 56;
export const NODE_PX = 44;
/** Column boxes on the inline axis, in % of the map width (logical: 0 = inline start). */
export const COLUMN_BOX: Record<MapColumn, { start: number; end: number }> = {
  0: { start: 0, end: 27 },
  1: { start: 34, end: 67 },
  2: { start: 74, end: 100 },
};

export interface PlacedNode extends KnowledgeMapNode {
  col: MapColumn;
  row: number;
}

export interface MapLayout {
  nodes: PlacedNode[];
  byId: Map<string, PlacedNode>;
  columns: PlacedNode[][];
  rows: number;
  heightPx: number;
}

export function layoutMap(data: Pick<KnowledgeMapResponse, 'nodes'>): MapLayout {
  const columns: PlacedNode[][] = [[], [], []];
  const sorted = [...data.nodes].sort((a, b) => COLUMN_OF[a.type] - COLUMN_OF[b.type] || a.order - b.order);
  for (const n of sorted) {
    const col = COLUMN_OF[n.type];
    columns[col]!.push({ ...n, col, row: columns[col]!.length });
  }
  const nodes = columns.flat();
  const rows = Math.max(1, ...columns.map((c) => c.length));
  return { nodes, byId: new Map(nodes.map((n) => [n.id, n])), columns, rows, heightPx: rows * ROW_PX };
}

/** Centre of a row (px). */
export const rowY = (row: number) => row * ROW_PX + NODE_PX / 2;

/** Physical x (% of width) of a logical inline position; in RTL the inline start is on the right. */
export const physX = (logical: number, rtl: boolean) => (rtl ? 100 - logical : logical);

export function neighbours(edges: Pick<KnowledgeMapEdge, 'from' | 'to'>[], id: string): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.from === id) out.add(e.to);
    else if (e.to === id) out.add(e.from);
  }
  return out;
}

export function edgesOf<E extends Pick<KnowledgeMapEdge, 'from' | 'to'>>(edges: E[], id: string): E[] {
  return edges.filter((e) => e.from === id || e.to === id);
}

export type MapMove = 'up' | 'down' | 'next' | 'prev' | 'first' | 'last';

/**
 * Keyboard move on the map: up / down inside the column; next / prev to the adjacent column (logical order:
 * lectures → concepts → questions), landing on the nearest CONNECTED node when there is one, else the nearest row;
 * first / last of the column.
 */
export function moveFocus(layout: MapLayout, edges: Pick<KnowledgeMapEdge, 'from' | 'to'>[], currentId: string | null, move: MapMove): string | null {
  const cur = currentId ? layout.byId.get(currentId) : undefined;
  if (!cur) return layout.nodes[0]?.id ?? null;
  const col = layout.columns[cur.col]!;
  if (move === 'up') return col[Math.max(0, cur.row - 1)]!.id;
  if (move === 'down') return col[Math.min(col.length - 1, cur.row + 1)]!.id;
  if (move === 'first') return col[0]!.id;
  if (move === 'last') return col[col.length - 1]!.id;
  // adjacent non-empty column
  const dir = move === 'next' ? 1 : -1;
  let c = cur.col + dir;
  while (c >= 0 && c <= 2 && layout.columns[c]!.length === 0) c += dir;
  if (c < 0 || c > 2) return cur.id;
  const target = layout.columns[c]!;
  const linked = neighbours(edges, cur.id);
  const pool = target.filter((n) => linked.has(n.id));
  const candidates = pool.length ? pool : target;
  return candidates.reduce((best, n) => (Math.abs(n.row - cur.row) < Math.abs(best.row - cur.row) ? n : best), candidates[0]!).id;
}

export const NODE_TYPE_AR: Record<KnowledgeMapNode['type'], string> = { lecture: 'محاضرة', concept: 'مفهوم', question: 'سؤال' };

/** Accessible name of a map node: its type, label, sub-label and how many links it has. */
export function nodeAccessibleName(n: KnowledgeMapNode, links: number): string {
  return `${NODE_TYPE_AR[n.type]}: ${n.label}${n.sublabel ? ` — ${n.sublabel}` : ''} — ${links === 0 ? 'لا روابط' : links === 1 ? 'رابط واحد' : links === 2 ? 'رابطان' : `${links} روابط`}`;
}

// ───────── knowledge states ─────────
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export const KNOWLEDGE_STATE_META: Record<KnowledgeState, { label: string; tone: Tone; icon: 'circle' | 'book' | 'pencil' | 'alert' | 'trend' | 'check' }> = {
  not_started: { label: KNOWLEDGE_STATE_LABELS_AR.not_started, tone: 'neutral', icon: 'circle' },
  read: { label: KNOWLEDGE_STATE_LABELS_AR.read, tone: 'info', icon: 'book' },
  practicing: { label: KNOWLEDGE_STATE_LABELS_AR.practicing, tone: 'info', icon: 'pencil' },
  needs_work: { label: KNOWLEDGE_STATE_LABELS_AR.needs_work, tone: 'warning', icon: 'alert' },
  developing: { label: KNOWLEDGE_STATE_LABELS_AR.developing, tone: 'accent', icon: 'trend' },
  strong: { label: KNOWLEDGE_STATE_LABELS_AR.strong, tone: 'success', icon: 'check' },
};

/** «تقدير: 80% (من 3 إجابات)» — or why there is none. Never a bare percentage. */
export function masteryText(value: number | null, sample: number): string {
  if (value === null) return `لا تقدير بعد (${sample === 0 ? 'لا إجابات محسوبة' : sample === 1 ? 'إجابة محسوبة واحدة' : `${sample} إجابات محسوبة`})`;
  return `تقدير: ${Math.round(value * 100)}% (من ${sample === 1 ? 'إجابة واحدة' : `${sample} إجابات`})`;
}

/** «3 من 9» — a count always with its denominator. */
export const ofAr = (n: number, d: number) => `${n} من ${d}`;

export function coverageLines(c: CoverageCount, noun: { plural: string }): Array<{ key: keyof CoverageCount; label: string; value: number; denominator: number }> {
  return [
    { key: 'with_source_questions', label: `${noun.plural} لها أسئلة من المصادر`, value: c.with_source_questions, denominator: c.total },
    { key: 'with_generated_questions', label: `${noun.plural} لها أسئلة مولدة`, value: c.with_generated_questions, denominator: c.total },
    { key: 'attempted', label: `${noun.plural} اختبرتها بسؤال واحد على الأقل`, value: c.attempted, denominator: c.total },
    { key: 'uncovered', label: `${noun.plural} بلا أي سؤال`, value: c.uncovered, denominator: c.total },
  ];
}

// ───────── Arabic counted nouns (Latin digits: 1, 2, 3–10, 11+) ─────────
export interface NounForms {
  one: string;
  two: string;
  few: string;
  many: string;
}
export const NOUNS = {
  page: { one: 'صفحة واحدة', two: 'صفحتان', few: 'صفحات', many: 'صفحة' },
  concept: { one: 'مفهوم واحد', two: 'مفهومان', few: 'مفاهيم', many: 'مفهومًا' },
  question: { one: 'سؤال واحد', two: 'سؤالان', few: 'أسئلة', many: 'سؤالًا' },
  lecture: { one: 'محاضرة واحدة', two: 'محاضرتان', few: 'محاضرات', many: 'محاضرة' },
} satisfies Record<string, NounForms>;

export function countAr(n: number, f: NounForms): string {
  if (n === 1) return f.one;
  if (n === 2) return f.two;
  const m = n % 100;
  if (n === 0 || (m >= 3 && m <= 10)) return `${n} ${f.few}`;
  return `${n} ${f.many}`;
}
