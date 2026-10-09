// Pure library model helpers (no React): tree building, ordering, search, trash roots, counts.
import {
  normalizeForSearch,
  type LibraryNodeView,
  type SortMode,
  type SourceSummary,
  type SourceType,
} from '@medlevo/shared';

export interface LibraryIndex {
  nodes: Map<string, LibraryNodeView>;
  /** parent id ('' = root) → child nodes (unsorted) */
  children: Map<string, LibraryNodeView[]>;
  /** node id → sources directly inside it */
  sourcesByNode: Map<string, SourceSummary[]>;
  sources: Map<string, SourceSummary>;
}

const ROOT = '';

export function buildIndex(nodes: LibraryNodeView[], sources: SourceSummary[]): LibraryIndex {
  const index: LibraryIndex = { nodes: new Map(), children: new Map(), sourcesByNode: new Map(), sources: new Map() };
  for (const n of nodes) index.nodes.set(n.id, n);
  for (const n of nodes) {
    // a parent that is not in this listing (e.g. archived/trashed and filtered out) makes the node a root
    const key = n.parent_id && index.nodes.has(n.parent_id) ? n.parent_id : ROOT;
    const list = index.children.get(key) ?? [];
    list.push(n);
    index.children.set(key, list);
  }
  for (const s of sources) {
    index.sources.set(s.id, s);
    const key = s.node_id ?? ROOT;
    const list = index.sourcesByNode.get(key) ?? [];
    list.push(s);
    index.sourcesByNode.set(key, list);
  }
  return index;
}

const collator = new Intl.Collator(['ar', 'en'], { numeric: true, sensitivity: 'base' });

type Sortable = { title: string; sort_order?: number; created_at: number; updated_at: number };

export function compareBy(mode: SortMode) {
  return (a: Sortable, b: Sortable): number => {
    switch (mode) {
      case 'title':
        return collator.compare(a.title, b.title) || a.created_at - b.created_at;
      case 'updated':
        return b.updated_at - a.updated_at;
      case 'created':
        return b.created_at - a.created_at;
      case 'manual':
      default:
        return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at - b.created_at;
    }
  };
}

export function sortItems<T extends Sortable>(items: readonly T[], mode: SortMode): T[] {
  return [...items].sort(compareBy(mode));
}

export function childrenOf(index: LibraryIndex, parentId: string | null, mode: SortMode = 'manual'): LibraryNodeView[] {
  return sortItems(index.children.get(parentId ?? ROOT) ?? [], mode);
}

export function sourcesIn(index: LibraryIndex, nodeId: string, mode: SortMode = 'manual'): SourceSummary[] {
  // sources carry their own sort_order but SourceSummary does not expose it: manual = upload order
  const list = index.sourcesByNode.get(nodeId) ?? [];
  if (mode === 'manual') return [...list];
  return sortItems(list, mode);
}

/** Root → node path (inclusive). Stops on cycles or missing parents. */
export function pathOf(index: LibraryIndex, nodeId: string | null): LibraryNodeView[] {
  const out: LibraryNodeView[] = [];
  const seen = new Set<string>();
  let cur = nodeId ? index.nodes.get(nodeId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? index.nodes.get(cur.parent_id) : undefined;
  }
  return out;
}

/** All descendant node ids (not including the node). */
export function descendantIds(index: LibraryIndex, nodeId: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(index.children.get(nodeId) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n.id)) continue;
    out.add(n.id);
    stack.push(...(index.children.get(n.id) ?? []));
  }
  return out;
}

/** Valid move destinations: never the node itself or anything inside it (cycle prevention, §05). */
export function canMoveInto(index: LibraryIndex, movingId: string, targetId: string | null): boolean {
  if (targetId === null) return true;
  if (targetId === movingId) return false;
  return !descendantIds(index, movingId).has(targetId);
}

export interface SubtreeCounts {
  folders: number;
  sources: number;
}

export function subtreeCounts(index: LibraryIndex, nodeId: string): SubtreeCounts {
  const ids = descendantIds(index, nodeId);
  let sources = index.sourcesByNode.get(nodeId)?.length ?? 0;
  for (const id of ids) sources += index.sourcesByNode.get(id)?.length ?? 0;
  return { folders: ids.size, sources };
}

/** Sources anywhere inside a node (used by the course view). */
export function sourcesInSubtree(index: LibraryIndex, nodeId: string): SourceSummary[] {
  const ids = [nodeId, ...descendantIds(index, nodeId)];
  return ids.flatMap((id) => index.sourcesByNode.get(id) ?? []);
}

export interface SearchHit {
  kind: 'node' | 'source';
  id: string;
  title: string;
  path: LibraryNodeView[];
  node?: LibraryNodeView;
  source?: SourceSummary;
}

/** Title search across the whole tree (Arabic-normalized, all tokens must match). */
export function searchLibrary(index: LibraryIndex, query: string, limit = 60): SearchHit[] {
  const tokens = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const matches = (title: string) => {
    const t = normalizeForSearch(title);
    return tokens.every((tok) => t.includes(tok));
  };
  const hits: SearchHit[] = [];
  for (const n of index.nodes.values()) {
    if (matches(n.title)) hits.push({ kind: 'node', id: n.id, title: n.title, path: pathOf(index, n.parent_id), node: n });
  }
  for (const s of index.sources.values()) {
    if (matches(s.title)) hits.push({ kind: 'source', id: s.id, title: s.title, path: pathOf(index, s.node_id), source: s });
  }
  hits.sort((a, b) => collator.compare(a.title, b.title));
  return hits.slice(0, limit);
}

/** Items carrying ALL the given tag ids. */
export function filterByTags<T extends { tags: Array<{ id: string }> }>(items: readonly T[], tagIds: readonly string[]): T[] {
  if (tagIds.length === 0) return [...items];
  return items.filter((it) => tagIds.every((id) => it.tags.some((t) => t.id === id)));
}

export interface TrashEntry {
  kind: 'node' | 'source';
  id: string;
  title: string;
  deleted_at: number;
  node?: LibraryNodeView;
  source?: SourceSummary;
  /** what was trashed together with it (subtree contents) */
  contains: SubtreeCounts;
}

/**
 * Trash roots from a tree listed with include=trash: an item is its own trash entry when its parent is
 * not in the trash, or was trashed at a different moment (it was trashed on its own before).
 */
export function trashEntries(nodes: LibraryNodeView[], sources: SourceSummary[]): TrashEntry[] {
  const index = buildIndex(nodes, sources);
  const out: TrashEntry[] = [];
  for (const n of nodes) {
    if (n.deleted_at === null) continue;
    const parent = n.parent_id ? index.nodes.get(n.parent_id) : undefined;
    if (parent && parent.deleted_at !== null && parent.deleted_at === n.deleted_at) continue;
    const trashedTogether = trashedSubtree(index, n);
    out.push({ kind: 'node', id: n.id, title: n.title, deleted_at: n.deleted_at, node: n, contains: trashedTogether });
  }
  for (const s of sources) {
    if (s.deleted_at === null) continue;
    const parent = s.node_id ? index.nodes.get(s.node_id) : undefined;
    if (parent && parent.deleted_at !== null && parent.deleted_at === s.deleted_at) continue;
    out.push({ kind: 'source', id: s.id, title: s.title, deleted_at: s.deleted_at, source: s, contains: { folders: 0, sources: 0 } });
  }
  return out.sort((a, b) => b.deleted_at - a.deleted_at);
}

function trashedSubtree(index: LibraryIndex, root: LibraryNodeView): SubtreeCounts {
  let folders = 0;
  let sources = (index.sourcesByNode.get(root.id) ?? []).filter((s) => s.deleted_at === root.deleted_at).length;
  for (const id of descendantIds(index, root.id)) {
    const n = index.nodes.get(id)!;
    if (n.deleted_at !== root.deleted_at) continue;
    folders++;
    sources += (index.sourcesByNode.get(id) ?? []).filter((s) => s.deleted_at === root.deleted_at).length;
  }
  return { folders, sources };
}

// ───────── course view grouping (§23) ─────────
export const COURSE_GROUPS: Array<{ key: string; title: string; types: SourceType[] }> = [
  { key: 'lectures', title: 'المحاضرات', types: ['lecture', 'lecture_audio'] },
  { key: 'references', title: 'المراجع', types: ['course_reference', 'textbook', 'guideline', 'image_atlas', 'practical_manual', 'external_source'] },
  { key: 'questions', title: 'مصادر الأسئلة', types: ['question_source', 'previous_exam'] },
  { key: 'mine', title: 'ملاحظاتي', types: ['my_notes', 'my_audio_note'] },
];

export function groupForCourse(sources: readonly SourceSummary[]): Array<{ key: string; title: string; sources: SourceSummary[] }> {
  return COURSE_GROUPS.map((g) => ({ key: g.key, title: g.title, sources: sources.filter((s) => g.types.includes(s.source_type)) })).filter(
    (g) => g.sources.length > 0,
  );
}
