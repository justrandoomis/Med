// Federated search (P1-T5 step 2; ARCHITECTURE_DELTA §11.1, §7.12; ADR-0003 §3.5; PRD AOS-14.15, 14.18, 14.19 Phase 1
// part). The vault is searched exactly as before (service.ts); official text is searched IN EACH SUBJECT SPACE the
// viewer may read, through the space's scoped FTS index with the ALLOWED versions as tokens inside the MATCH:
//   * scope `mine`     — the vault, plus the official versions the viewer's copies (stubs) hold;
//   * scope `subjects` — the published heads of the official lectures of every subject the viewer belongs to;
//   * scope `all`      — both (the default).
// Rules: an approved membership (or a role) in THAT subject is checked per space on every request — a non-member, a
// pending member or a moderator of another subject never gets a hit from it; drafts, withdrawn and taken-down lectures
// are never searched; every hit is checked again against the allowed versions after the MATCH; hits are labelled with
// the database they come from; nothing of a vault ever goes to a space query (only the viewer's own search terms).
// Merge: reciprocal-rank fusion (k = 60) of the vault list and each space list; ties keep sources before the owner's
// notes before generated text.
import { findExactPhrase, findHighlights, makeSnippet, type SearchResult, type SourceType } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { locatorLabelAr, type PageForLabel } from '../evidence/evidence';
import type { BuiltQuery } from '../evidence/terms';
import { forksSystem } from '../forks/system';
import { MAX_SCOPE_TOKENS, scopedMatch } from './scopeTokens';

export const SEARCH_SCOPES = ['mine', 'subjects', 'all'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export const RRF_K = 60;

export interface SpaceSearchReport {
  spaces: number;
  /** spaces whose allowed-version list was larger than the MATCH holds: searched by a capped post-filter (flagged) */
  truncated: number;
  ms: number;
}

interface AllowedVersion {
  version_id: string;
  lecture_id: string;
  source_id: string;
  title: string;
  /** the published head (searched through the one `hd` token); else a version the viewer's copy holds */
  head: boolean;
}

interface Hit {
  id: string;
  version_id: string;
  source_id: string;
  heading_path: string | null;
  text: string;
  region_ids_json: string;
  rank: number;
}

/** The official versions of one space the viewer may search (never a draft, a withdrawn or a taken-down lecture). */
function allowedVersions(ctx: AppContext, space: Db, spaceId: string, scope: SearchScope): AllowedVersion[] {
  const out = new Map<string, AllowedVersion>();
  if (scope !== 'mine') {
    for (const r of space.all<AllowedVersion>(
      `SELECT l.head_version_id AS version_id, l.id AS lecture_id, l.source_id, l.title, 1 AS head FROM official_lecture l
        WHERE l.status = 'published' AND l.takedown_at IS NULL AND l.head_version_id IS NOT NULL`,
    )) {
      out.set(r.version_id, { ...r, head: true });
    }
  }
  if (scope !== 'subjects') {
    // the versions the viewer's own stubs hold (an earlier version their notes sit on is searchable too)
    const held = ctx.db.all<{ id: string; origin_lecture_id: string }>(
      `SELECT v.id, s.origin_lecture_id FROM source s JOIN source_version v ON v.source_id = s.id WHERE s.is_stub = 1 AND s.origin_space_id = ? AND s.deleted_at IS NULL`,
      [spaceId],
    );
    if (held.length) {
      const ids = held.map((h) => h.id);
      for (const r of space.all<AllowedVersion>(
        `SELECT p.version_id, l.id AS lecture_id, l.source_id, l.title, CASE WHEN l.head_version_id = p.version_id THEN 1 ELSE 0 END AS head
           FROM official_version_publish p JOIN official_lecture l ON l.id = p.lecture_id
          WHERE l.status = 'published' AND l.takedown_at IS NULL AND p.version_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      )) {
        if (!out.has(r.version_id)) out.set(r.version_id, r);
      }
    }
  }
  return [...out.values()];
}

/** the `hd` token is maintained by the lectures module on publish / withdraw (migration-space 3300) */
const scopeHeadsUsable = true;

/** Candidate cap of the post-filter fallback (a version set too large for the MATCH; flagged in `searched`). */
const POST_FILTER_CAP = 2000;

/**
 * Ranked hits of one space for `match`: the allowed versions as scope tokens inside the MATCH, then the exact
 * allowed-version check. A set larger than MAX_SCOPE_TOKENS falls back to a post-filter on a capped candidate set
 * (ARCHITECTURE_DELTA §11.1) — reported, never silent.
 */
function searchSpace(space: Db, allowed: Map<string, AllowedVersion>, match: string, fetch: number): { hits: Hit[]; postFiltered: boolean } {
  const sql = `SELECT c.id, c.version_id, c.source_id, c.heading_path, c.text, c.region_ids_json, bm25(chunk_scope_fts) AS rank
       FROM chunk_scope_fts JOIN document_chunk c ON c.rowid = chunk_scope_fts.rowid
      WHERE chunk_scope_fts MATCH ? ORDER BY rank LIMIT ?`;
  // every published head is ONE token (`hd`); only the other versions (held by the viewer's copies) are named
  const heads = [...allowed.values()].some((v) => v.head && scopeHeadsUsable);
  const named = [...allowed.values()].filter((v) => !(v.head && scopeHeadsUsable)).map((v) => v.version_id);
  if (named.length > MAX_SCOPE_TOKENS) {
    const rows = space.all<Hit>(sql, [`{text heading_path} : (${match})`, POST_FILTER_CAP]);
    return { hits: rows.filter((r) => allowed.has(r.version_id)).slice(0, fetch), postFiltered: true };
  }
  const q = scopedMatch(named, match, { heads });
  if (!q) return { hits: [], postFiltered: false };
  return { hits: space.all<Hit>(sql, [q, fetch]).filter((r) => allowed.has(r.version_id)), postFiltered: false };
}

function location(space: Db, hit: Hit, hl: (t: string) => unknown[]): SearchResult['location'] {
  const regionIds = fromJson<string[]>(hit.region_ids_json, []) ?? [];
  let chosen: { id: string; page_id: string | null; locator_json: string | null } | undefined;
  for (const rid of regionIds.slice(0, 40)) {
    const reg = space.get<{ id: string; page_id: string | null; locator_json: string | null; text: string | null }>('SELECT id, page_id, locator_json, text FROM source_region WHERE id = ?', [rid]);
    if (!reg) continue;
    chosen ??= reg;
    if (reg.text && hl(reg.text).length > 0) {
      chosen = reg;
      break;
    }
  }
  const page = chosen?.page_id ? space.get<PageForLabel & { id: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE id = ?', [chosen.page_id]) : undefined;
  return {
    source_id: hit.source_id,
    version_id: hit.version_id,
    page_id: page?.id ?? null,
    page_index: page?.page_index ?? null,
    page_label_ar: page || chosen ? locatorLabelAr(space, page ?? null, fromJson<Record<string, unknown>>(chosen?.locator_json ?? null)) : null,
    region_id: chosen?.id ?? null,
  };
}

const clean = (t: string | null | undefined) => (t ?? '').replace(/[\r\n\t]+/g, ' ').trim();

export interface FederatedInput {
  viewer: Viewer;
  scope: SearchScope;
  q: string;
  mode: 'keyword' | 'exact';
  built: BuiltQuery;
  /** only official text (no source / version / folder filter that names the vault) */
  sourceType?: SourceType;
  sourceId?: string;
  fetch: number;
}

/**
 * The official-text hit lists, one per readable space (already ranked), and what was searched. Space hits are typed
 * `chunks`, origin `source`, never evidence; `db` names the space and the subject.
 */
export function federatedLists(ctx: AppContext, input: FederatedInput): { lists: SearchResult[][]; report: SpaceSearchReport; exactRejected: number } {
  const t0 = performance.now();
  const report: SpaceSearchReport = { spaces: 0, truncated: 0, ms: 0 };
  let exactRejected = 0;
  const match = input.mode === 'exact' ? input.built.phrase : input.built.and;
  if (!match || (input.sourceType && input.sourceType !== 'lecture')) return { lists: [], report, exactRejected };
  const hl = input.mode === 'exact' ? (t: string) => findExactPhrase(t, input.q) : (t: string) => findHighlights(t, input.built.highlightTokens);
  const sys = forksSystem(ctx);
  const dir = publicDirectory(ctx.system);
  const lists: SearchResult[][] = [];
  for (const m of sys.spacesOfViewer(input.viewer)) {
    let space: Db;
    try {
      space = ctx.dbs.space(m.spaceId);
    } catch {
      continue;
    }
    let versions = allowedVersions(ctx, space, m.spaceId, input.scope);
    if (input.sourceId) versions = versions.filter((v) => v.source_id === input.sourceId);
    if (versions.length === 0) continue;
    report.spaces++;
    const allowed = new Map(versions.map((v) => [v.version_id, v]));
    const inLibrary = new Set(
      ctx.db.all<{ l: string }>('SELECT origin_lecture_id AS l FROM source WHERE is_stub = 1 AND origin_space_id = ? AND deleted_at IS NULL', [m.spaceId]).map((r) => r.l),
    );
    const subject = { id: m.subjectNodeId, kind: 'subject' as const, title: dir.spaceTitle(input.viewer, m.spaceId) ?? '' };
    const list: SearchResult[] = [];
    const found = searchSpace(space, allowed, match, input.fetch * (input.mode === 'exact' ? 3 : 1));
    if (found.postFiltered) report.truncated++;
    for (const h of found.hits) {
      const hs = hl(h.text) as ReturnType<typeof findHighlights>;
      if (input.mode === 'exact' && hs.length === 0) {
        exactRejected++;
        continue;
      }
      const v = allowed.get(h.version_id)!;
      const heading = h.heading_path?.split(' › ').pop();
      list.push({
        type: 'chunks',
        id: h.id,
        title: heading ? `${clean(v.title)} › ${clean(heading)}` : clean(v.title),
        snippet: makeSnippet(h.text, hs),
        location: location(space, h, hl),
        origin: 'source',
        source_type: 'lecture',
        source_title: clean(v.title),
        is_evidence: false,
        db: { kind: 'space', space_id: m.spaceId, subject, lecture_id: v.lecture_id, in_library: inLibrary.has(v.lecture_id) },
      });
    }
    if (list.length) lists.push(list);
  }
  report.ms = Math.round((performance.now() - t0) * 10) / 10;
  return { lists, report, exactRejected };
}

/** Reciprocal-rank fusion of ranked lists (k = 60); ties: sources, then the owner's notes, then generated text. */
export function fuse(lists: SearchResult[][]): SearchResult[] {
  const group = (r: SearchResult) => (r.origin === 'source' ? 0 : r.origin === 'generated' ? 2 : 1);
  const scored: Array<{ r: SearchResult; score: number; g: number; order: number }> = [];
  let order = 0;
  for (const list of lists) list.forEach((r, i) => scored.push({ r, score: 1 / (RRF_K + i + 1), g: group(r), order: order++ }));
  scored.sort((a, b) => b.score - a.score || a.g - b.g || a.order - b.order);
  return scored.map((s) => s.r);
}
