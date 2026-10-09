// Retrieval chunks (§52): a chunk is a paragraph group under one heading path, a table (serialized with
// its header context), or a figure with its caption — never a fixed character window. Header/footer
// regions are excluded. Chunks keep prev/next links and the pages/regions they came from.
// Re-indexing is a DIFF: an unchanged chunk keeps its id; only changed chunks are replaced.
import type { DiagramStructure, FigureStructure, TableStructure } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import { estimateTokens } from './text';

export const INDEX_VERSION = 'chunk-v1';
export const HEADING_SEPARATOR = ' › ';
const TARGET_CHARS = 1200;

interface RegionRow {
  id: string;
  page_id: string;
  page_index: number;
  page_kind: string;
  parent_region_id: string | null;
  kind: string;
  reading_order: number;
  text: string | null;
  locator_json: string | null;
  structure_json: string | null;
}

export interface ChunkDraft {
  kind: 'text' | 'table' | 'figure' | 'note';
  heading_path: string | null;
  text: string;
  region_ids: string[];
  page_ids: string[];
}

interface ChunkRow {
  id: string;
  kind: string;
  heading_path: string | null;
  text: string;
  region_ids_json: string;
  page_ids_json: string;
  prev_chunk_id: string | null;
  next_chunk_id: string | null;
  index_version: string;
}

const TEXT_KINDS = new Set(['paragraph', 'list_item', 'text_block', 'question', 'option', 'answer_key', 'transcript']);

function headingLevels(rows: RegionRow[]): (r: RegionRow) => number {
  // explicit levels (office) win; otherwise rank distinct heading font sizes (largest = level 1)
  const sizes = new Set<number>();
  for (const r of rows) {
    if (r.kind !== 'heading') continue;
    const loc = fromJson<{ heading_level?: number; font_size?: number }>(r.locator_json) ?? {};
    if (!loc.heading_level && typeof loc.font_size === 'number') sizes.add(Math.round(loc.font_size * 2) / 2);
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  return (r) => {
    const loc = fromJson<{ heading_level?: number; font_size?: number }>(r.locator_json) ?? {};
    if (loc.heading_level) return loc.heading_level;
    if (typeof loc.font_size === 'number') return ranked.indexOf(Math.round(loc.font_size * 2) / 2) + 1 || 1;
    return 1;
  };
}

/** Build chunk drafts for a version from its persisted regions (deterministic). */
export function buildChunks(ctx: AppContext, versionId: string): ChunkDraft[] {
  const rows = ctx.db.all<RegionRow>(
    `SELECT r.id, r.page_id, p.page_index, p.kind AS page_kind, r.parent_region_id, r.kind, r.reading_order, r.text, r.locator_json, r.structure_json
       FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.status <> 'rejected'
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const levelOf = headingLevels(rows);

  // captions consumed by their table/figure; diagrams consumed by their figure
  const consumed = new Set<string>();
  const diagramOf = new Map<string, RegionRow>();
  for (const r of rows) {
    if (r.kind === 'table' || r.kind === 'figure') {
      const s = fromJson<TableStructure | FigureStructure>(r.structure_json);
      if (s?.caption_region_id) consumed.add(s.caption_region_id);
    }
    if (r.kind === 'diagram' && r.parent_region_id) {
      diagramOf.set(r.parent_region_id, r);
      consumed.add(r.id);
    }
  }

  const drafts: ChunkDraft[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let pending: { regions: RegionRow[]; kind: 'text' | 'note' } | null = null;
  const path = () => (stack.length ? stack.map((h) => h.text).join(HEADING_SEPARATOR) : null);
  const flush = () => {
    if (!pending || pending.regions.length === 0) {
      pending = null;
      return;
    }
    drafts.push({
      kind: pending.kind,
      heading_path: path(),
      text: pending.regions.map((r) => r.text!.trim()).join('\n'),
      region_ids: pending.regions.map((r) => r.id),
      page_ids: [...new Set(pending.regions.map((r) => r.page_id))],
    });
    pending = null;
  };

  let lastPage: string | null = null;
  for (const r of rows) {
    // separate images / slides are independent units: text never flows from one into the next
    if (r.page_id !== lastPage) {
      if (lastPage !== null && (r.page_kind === 'image' || r.page_kind === 'slide')) flush();
      lastPage = r.page_id;
    }
    if (r.kind === 'header' || r.kind === 'footer' || r.kind === 'table_cell' || consumed.has(r.id)) continue;
    if (r.parent_region_id && r.kind !== 'diagram') continue;
    if (r.kind === 'heading') {
      flush();
      const level = levelOf(r);
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      if (r.text?.trim()) stack.push({ level, text: r.text.trim().slice(0, 300) });
      continue;
    }
    if (r.kind === 'table') {
      flush();
      if (r.text?.trim()) drafts.push({ kind: 'table', heading_path: path(), text: r.text.trim(), region_ids: withCaption(r), page_ids: pagesOf([r.id, ...withCaption(r)]) });
      continue;
    }
    if (r.kind === 'figure') {
      flush();
      const s = fromJson<FigureStructure>(r.structure_json);
      const caption = s?.caption_region_id ? byId.get(s.caption_region_id) : undefined;
      const diagram = diagramOf.get(r.id);
      const labels = diagram ? (fromJson<DiagramStructure>(diagram.structure_json)?.nodes ?? []).map((n) => n.label).filter(Boolean) : [];
      const parts = [caption?.text?.trim(), labels.length ? labels.join(' · ') : null].filter((x): x is string => !!x);
      if (parts.length) {
        const ids = [r.id, ...(caption ? [caption.id] : []), ...(diagram ? [diagram.id] : [])];
        drafts.push({ kind: 'figure', heading_path: path(), text: parts.join('\n'), region_ids: ids, page_ids: pagesOf(ids) });
      }
      continue;
    }
    const kind: 'text' | 'note' | null = r.kind === 'note' ? 'note' : TEXT_KINDS.has(r.kind) || r.kind === 'caption' ? 'text' : null;
    if (!kind || !r.text?.trim()) continue;
    if (pending && (pending.kind !== kind || pendingChars(pending.regions) + r.text.length > TARGET_CHARS)) flush();
    pending ??= { regions: [], kind };
    pending.regions.push(r);
  }
  flush();
  return drafts;

  function withCaption(r: RegionRow): string[] {
    const s = fromJson<TableStructure>(r.structure_json);
    return [r.id, ...(s?.caption_region_id && byId.has(s.caption_region_id) ? [s.caption_region_id] : [])];
  }
  function pagesOf(ids: string[]): string[] {
    return [...new Set(ids.map((id) => byId.get(id)?.page_id).filter((p): p is string => !!p))];
  }
}

function pendingChars(regions: RegionRow[]): number {
  return regions.reduce((n, r) => n + (r.text?.length ?? 0), 0);
}

const keyOf = (c: { kind: string; heading_path: string | null; text: string; region_ids_json: string }) =>
  `${c.kind}\u0000${c.heading_path ?? ''}\u0000${c.region_ids_json}\u0000${c.text}`;

/** Replace the version's chunks with `drafts` (diff by content; unchanged chunks keep their ids). */
export function writeChunks(ctx: AppContext, versionId: string, sourceId: string, drafts: ChunkDraft[]): { inserted: number; deleted: number; kept: number } {
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const existing = ctx.db.all<ChunkRow>(
      'SELECT id, kind, heading_path, text, region_ids_json, page_ids_json, prev_chunk_id, next_chunk_id, index_version FROM document_chunk WHERE version_id = ?',
      [versionId],
    );
    const pool = new Map<string, ChunkRow[]>();
    for (const c of existing) {
      if (c.index_version !== INDEX_VERSION) continue;
      const k = keyOf(c);
      pool.set(k, [...(pool.get(k) ?? []), c]);
    }
    const keptIds = new Set<string>();
    const finalIds: string[] = [];
    let inserted = 0;
    for (const d of drafts) {
      const regionJson = toJson(d.region_ids)!;
      const k = keyOf({ kind: d.kind, heading_path: d.heading_path, text: d.text, region_ids_json: regionJson });
      const match = pool.get(k)?.shift();
      if (match) {
        keptIds.add(match.id);
        finalIds.push(match.id);
        continue;
      }
      finalIds.push(newId(now));
      inserted++;
    }
    // delete chunks that are no longer produced (FTS rows follow via trigger)
    let deleted = 0;
    for (const c of existing) {
      if (!keptIds.has(c.id)) {
        ctx.db.run('DELETE FROM document_chunk WHERE id = ?', [c.id]);
        deleted++;
      }
    }
    drafts.forEach((d, i) => {
      const id = finalIds[i]!;
      const prev = i > 0 ? finalIds[i - 1]! : null;
      const next = i + 1 < finalIds.length ? finalIds[i + 1]! : null;
      if (keptIds.has(id)) {
        ctx.db.run('UPDATE document_chunk SET prev_chunk_id = ?, next_chunk_id = ? WHERE id = ? AND (prev_chunk_id IS NOT ? OR next_chunk_id IS NOT ?)', [prev, next, id, prev, next]);
      } else {
        ctx.db.run(
          `INSERT INTO document_chunk (id, version_id, source_id, kind, heading_path, text, region_ids_json, page_ids_json, prev_chunk_id, next_chunk_id,
             token_estimate, index_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, versionId, sourceId, d.kind, d.heading_path, d.text, toJson(d.region_ids), toJson(d.page_ids), prev, next, estimateTokens(d.text), INDEX_VERSION, now],
        );
      }
    });
    return { inserted, deleted, kept: keptIds.size };
  });
}
