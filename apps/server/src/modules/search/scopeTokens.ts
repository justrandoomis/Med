// Scope tokens of the space's scoped FTS index (P1-T5 step 2; migration-space 3300_scoped_fts; ARCHITECTURE_DELTA §11.1;
// ADR-0003 §3.5). The index stores `v<version id>` and `s<source id>` in its `scope` column, lower-case and without '_'
// and '-' (the unicode61 tokenizer splits on them); a query puts the ALLOWED versions inside the MATCH, so out-of-scope
// chunks never reach bm25 ranking or LIMIT. Callers still check each hit's version afterwards (a cheap, exact filter).
import type { Db } from '../../db/db';

export const MAX_SCOPE_TOKENS = 500;
/** the token of the chunks of a published official head (migration-space 3300) */
export const HEAD_TOKEN = 'hd';

export function scopeToken(kind: 'v' | 's', id: string): string {
  return `${kind}${id.replace(/[_-]/g, '').toLowerCase()}`;
}

/**
 * `(scope : (vA OR vB … [OR hd])) AND ({text heading_path} : (<terms>))` — null when there is nothing to search.
 * `heads: true` adds the published-heads token (every official lecture of the space as students see it).
 */
export function scopedMatch(versionIds: readonly string[], terms: string | null, opts: { heads?: boolean } = {}): string | null {
  if (!terms) return null;
  const tokens = [...new Set(versionIds.map((v) => scopeToken('v', v)))].filter((t) => /^[a-z0-9]+$/.test(t));
  if (opts.heads) tokens.unshift(HEAD_TOKEN);
  if (tokens.length === 0) return null;
  return `(scope : (${tokens.join(' OR ')})) AND ({text heading_path} : (${terms}))`;
}

/**
 * Re-index the scoped FTS rows of these versions' chunks (call it in the SPACE, in the transaction that changed which
 * version is a published head: publish, withdraw). The scope text is recomputed exactly like the insert trigger, and —
 * like the triggers — only PUBLISHED versions are indexed (review P1-T5 s2 R-E: a draft in the index would change the
 * bm25 ranking members see).
 */
export function retokenizeVersions(db: Db, versionIds: ReadonlyArray<string | null | undefined>): void {
  const ids = [...new Set(versionIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  if (!db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'chunk_scope_fts'`)) return; // a vault: no scoped index
  const inV = ids.map(() => '?').join(',');
  db.run(`DELETE FROM chunk_scope_fts WHERE rowid IN (SELECT rowid FROM document_chunk WHERE version_id IN (${inV}))`, ids);
  db.run(
    `INSERT INTO chunk_scope_fts(rowid, text, heading_path, scope)
       SELECT c.rowid, ml_norm(c.text), ml_norm(coalesce(c.heading_path, '')),
              'v' || lower(replace(replace(c.version_id, '_', ''), '-', '')) || ' s' || lower(replace(replace(c.source_id, '_', ''), '-', ''))
              || CASE WHEN EXISTS (SELECT 1 FROM official_lecture l WHERE l.head_version_id = c.version_id AND l.status = 'published' AND l.takedown_at IS NULL) THEN ' hd' ELSE '' END
         FROM document_chunk c WHERE c.version_id IN (${inV})
          AND EXISTS (SELECT 1 FROM official_version_publish p WHERE p.version_id = c.version_id)`,
    ids,
  );
}
