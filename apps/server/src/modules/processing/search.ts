// Keyword retrieval over processed chunks. The scope is REQUIRED (no default "everything"): the version
// filter is part of the same SQL statement as the FTS match, so out-of-scope chunks are excluded BEFORE
// ranking and LIMIT (§08, §52, ARCHITECTURE §3.7). Queries are normalized exactly like the index
// (toFtsQuery → normalizeForSearch ↔ ml_norm in the chunk_fts triggers).
import type { ResolvedScope } from '@medlevo/shared';
import { toFtsQuery } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';

export interface ChunkHit {
  id: string;
  version_id: string;
  source_id: string;
  kind: string;
  heading_path: string | null;
  text: string;
  region_ids: string[];
  page_ids: string[];
  rank: number;
}

export function searchChunks(db: Db, scope: Pick<ResolvedScope, 'versionIds'>, query: string, opts: { limit?: number; prefix?: boolean } = {}): ChunkHit[] {
  const match = toFtsQuery(query, { prefix: opts.prefix ?? false });
  if (!match || scope.versionIds.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const placeholders = scope.versionIds.map(() => '?').join(',');
  const rows = db.all<{
    id: string;
    version_id: string;
    source_id: string;
    kind: string;
    heading_path: string | null;
    text: string;
    region_ids_json: string;
    page_ids_json: string;
    rank: number;
  }>(
    `SELECT c.id, c.version_id, c.source_id, c.kind, c.heading_path, c.text, c.region_ids_json, c.page_ids_json, bm25(chunk_fts) AS rank
       FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid
      WHERE chunk_fts MATCH ? AND c.version_id IN (${placeholders})
      ORDER BY rank LIMIT ?`,
    [match, ...scope.versionIds, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    version_id: r.version_id,
    source_id: r.source_id,
    kind: r.kind,
    heading_path: r.heading_path,
    text: r.text,
    region_ids: fromJson<string[]>(r.region_ids_json, []) ?? [],
    page_ids: fromJson<string[]>(r.page_ids_json, []) ?? [],
    rank: r.rank,
  }));
}
