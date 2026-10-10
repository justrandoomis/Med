// Universal Search (§46). Keyword / exact search over:
//   chunks      chunk_fts (document chunks of the ACTIVE version — frozen ?? current — of live sources)
//   questions   question_fts (filled by the questions track; normalized key like chunk_fts)
//   notes       owner_content_fts entity 'note' (annotations track; normalized key only → snippet from the note)
//   generated   owner_content_fts origin 'generated' (study-book track: artifacts / blocks / messages)
//   transcripts owner_content_fts entity 'transcript_segment' (no producer yet → notice)
//   handwriting owner_content_fts entity 'ink_recognition' (track F4: readings of the owner's pen strokes; origin
//               «مقروء آليًا», or «كتبته بنفسك» once the owner corrected it; strokes all erased → not returned)
// Rules:
//  * filters (source type, library node subtree, source / version) are applied in SQL in the same statement as
//    MATCH, i.e. BEFORE bm25 ranking and LIMIT;
//  * exact mode prefilters with an FTS phrase and then VERIFIES the phrase on the original text;
//  * highlight ranges are computed on the original (never normalized) text, bidi-safe;
//  * generated content is labelled, ranked after source results and never returned as evidence;
//  * semantic mode is not available (capability search.semantic) — the route refuses it with the reason.
import {
  findExactPhrase,
  findHighlights,
  makeSnippet,
  pageDisplayLabel,
  richTextToPlain,
  SEARCH_RESULT_TYPES,
  type RichText,
  type SearchHighlight,
  type SearchLocation,
  type SearchMode,
  type SearchOrigin,
  type SearchResponse,
  type SearchResult,
  type SearchResultType,
  type SourceType,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { locatorLabelAr, type PageForLabel } from '../evidence/evidence';
import { buildQuery, type BuiltQuery } from '../evidence/terms';

export interface SearchParams {
  q: string;
  mode: Exclude<SearchMode, 'semantic'>;
  types: SearchResultType[];
  source_type?: SourceType;
  node_id?: string;
  source_id?: string;
  version_id?: string;
  limit: number;
  offset: number;
}

interface Scored {
  result: SearchResult;
  /** 0 = source, 1 = owner notes / recognized, 2 = generated */
  group: number;
  rank: number;
}

const GROUP: Record<SearchOrigin, number> = { source: 0, recognized: 1, imported: 1, owner_typed: 1, owner_note: 1, generated: 2 };

function clean(t: string | null | undefined): string {
  return (t ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/** Library subtree of a node (live nodes only) as an SQL fragment over a source alias. */
function nodeFilter(alias: string): string {
  return `(${alias}.node_id IN (SELECT id FROM node_tree) OR ${alias}.subject_node_id = ? OR ${alias}.course_node_id = ?)`;
}
const NODE_TREE_CTE = `node_tree(id) AS (
    SELECT id FROM library_node WHERE id = ? AND deleted_at IS NULL
    UNION ALL SELECT n.id FROM library_node n JOIN node_tree t ON n.parent_id = t.id WHERE n.deleted_at IS NULL
  )`;

interface Highlighter {
  (text: string): SearchHighlight[];
}

function highlighter(mode: SearchParams['mode'], q: string, built: BuiltQuery): Highlighter {
  return mode === 'exact' ? (text) => findExactPhrase(text, q) : (text) => findHighlights(text, built.highlightTokens);
}

// ───────── chunks ─────────
interface ChunkHitRow {
  id: string;
  version_id: string;
  source_id: string;
  heading_path: string | null;
  text: string;
  region_ids_json: string;
  title: string;
  source_type: SourceType;
  rank: number;
}

function searchChunks(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const where: string[] = ['s.deleted_at IS NULL', 'COALESCE(s.frozen_version_id, s.current_version_id) IS NOT NULL'];
  const params: unknown[] = [];
  if (p.source_type) {
    where.push('s.source_type = ?');
    params.push(p.source_type);
  }
  if (p.source_id) {
    where.push('s.id = ?');
    params.push(p.source_id);
  }
  if (p.node_id) {
    where.push(nodeFilter('s'));
    params.push(p.node_id, p.node_id);
  }
  // an explicit version (e.g. an older one opened in the reader) replaces the active-version rule
  const versionExpr = p.version_id ? '?' : 'COALESCE(s.frozen_version_id, s.current_version_id)';
  const allowed = `SELECT ${versionExpr} FROM source s WHERE ${where.join(' AND ')}${p.version_id ? ' AND s.id = (SELECT source_id FROM source_version WHERE id = ?)' : ''}`;
  const allowedParams = p.version_id ? [p.version_id, ...params, p.version_id] : params;
  const cte = p.node_id ? `WITH RECURSIVE ${NODE_TREE_CTE} ` : '';
  const cteParams = p.node_id ? [p.node_id] : [];
  const rows = ctx.db.all<ChunkHitRow>(
    `${cte}SELECT c.id, c.version_id, c.source_id, c.heading_path, c.text, c.region_ids_json, s2.title, s2.source_type, bm25(chunk_fts) AS rank
       FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid JOIN source s2 ON s2.id = c.source_id
      WHERE chunk_fts MATCH ? AND c.version_id IN (${allowed})
      ORDER BY rank LIMIT ?`,
    [...cteParams, match, ...allowedParams, fetch],
  );
  const out: Scored[] = [];
  for (const r of rows) {
    const hs = hl(r.text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const loc = chunkLocation(ctx, r, hl);
    const heading = r.heading_path?.split(' › ').pop();
    out.push({
      group: 0,
      rank: r.rank,
      result: {
        type: 'chunks',
        id: r.id,
        title: heading ? `${clean(r.title)} › ${clean(heading)}` : clean(r.title),
        snippet: makeSnippet(r.text, hs),
        location: loc.location,
        origin: loc.recognized ? 'recognized' : 'source',
        source_type: r.source_type,
        source_title: clean(r.title),
        is_evidence: false,
      },
    });
  }
  return out;
}

function chunkLocation(ctx: AppContext, r: ChunkHitRow, hl: Highlighter): { location: SearchLocation; recognized: boolean } {
  const regionIds = fromJson<string[]>(r.region_ids_json, []) ?? [];
  let chosen: { id: string; page_id: string | null; locator_json: string | null; text_origin: string | null } | undefined;
  let first: typeof chosen;
  for (const rid of regionIds) {
    const reg = ctx.db.get<{ id: string; page_id: string | null; locator_json: string | null; text_origin: string | null; text: string | null }>(
      'SELECT id, page_id, locator_json, text_origin, text FROM source_region WHERE id = ?',
      [rid],
    );
    if (!reg) continue;
    first ??= reg;
    if (reg.text && hl(reg.text).length > 0) {
      chosen = reg;
      break;
    }
  }
  chosen ??= first;
  const page = chosen?.page_id
    ? ctx.db.get<PageForLabel & { id: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE id = ?', [chosen.page_id])
    : undefined;
  return {
    recognized: chosen?.text_origin === 'ocr',
    location: {
      source_id: r.source_id,
      version_id: r.version_id,
      page_id: page?.id ?? null,
      page_index: page?.page_index ?? null,
      page_label_ar: page || chosen ? locatorLabelAr(page ?? null, fromJson<Record<string, unknown>>(chosen?.locator_json ?? null)) : null,
      region_id: chosen?.id ?? null,
    },
  };
}

// ───────── questions ─────────
function searchQuestions(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const filters: string[] = ['q.deleted_at IS NULL'];
  const params: unknown[] = [];
  const occFilters: string[] = ['s.deleted_at IS NULL'];
  const occParams: unknown[] = [];
  if (p.source_type) {
    occFilters.push('s.source_type = ?');
    occParams.push(p.source_type);
  }
  if (p.source_id) {
    occFilters.push('s.id = ?');
    occParams.push(p.source_id);
  }
  if (p.node_id) {
    occFilters.push(nodeFilter('s'));
    occParams.push(p.node_id, p.node_id);
  }
  const needsOcc = p.source_type || p.source_id || p.node_id;
  if (needsOcc) {
    filters.push(`EXISTS (SELECT 1 FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = q.id AND ${occFilters.join(' AND ')})`);
    params.push(...occParams);
  } else {
    // a source question whose every occurrence is in the trash is hidden like its source
    filters.push(`(q.origin_type <> 'source' OR EXISTS (SELECT 1 FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = q.id AND s.deleted_at IS NULL))`);
  }
  const cte = p.node_id ? `WITH RECURSIVE ${NODE_TREE_CTE} ` : '';
  const rows = ctx.db.all<{ question_id: string; version_id: string; origin_type: 'source' | 'generated' | 'owner'; rank: number }>(
    `${cte}SELECT f.question_id, f.version_id, q.origin_type, bm25(question_fts) AS rank
       FROM question_fts f JOIN question q ON q.id = f.question_id
      WHERE question_fts MATCH ? AND ${filters.join(' AND ')}
      ORDER BY rank LIMIT ?`,
    [...(p.node_id ? [p.node_id] : []), match, ...params, fetch],
  );
  const out: Scored[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.question_id)) continue;
    seen.add(r.question_id);
    const v = ctx.db.get<{ stem_raw: string | null; stem_json: string | null }>('SELECT stem_raw, stem_json FROM question_version WHERE id = ?', [r.version_id]);
    const text = clean(v?.stem_raw) || richTextToPlain(fromJson<RichText>(v?.stem_json ?? null)) || '';
    const hs = hl(text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const occ = ctx.db.get<{ source_id: string; source_version_id: string; page_ids_json: string; region_ids_json: string; printed_number: string | null; title: string; source_type: SourceType }>(
      `SELECT o.source_id, o.source_version_id, o.page_ids_json, o.region_ids_json, o.printed_number, s.title, s.source_type
         FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.created_at LIMIT 1`,
      [r.question_id],
    );
    const pageId = occ ? (fromJson<string[]>(occ.page_ids_json, []) ?? [])[0] : undefined;
    const page = pageId ? ctx.db.get<PageForLabel & { id: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE id = ?', [pageId]) : undefined;
    const origin: SearchOrigin = r.origin_type === 'source' ? 'source' : r.origin_type === 'generated' ? 'generated' : 'owner_note';
    out.push({
      group: GROUP[origin],
      rank: r.rank,
      result: {
        type: 'questions',
        id: r.question_id,
        title: occ ? `${clean(occ.title)}${occ.printed_number ? ` — سؤال ${occ.printed_number}` : ''}` : origin === 'generated' ? 'سؤال مولَّد' : 'سؤال كتبتُه',
        snippet: makeSnippet(text, hs),
        location: occ
          ? {
              source_id: occ.source_id,
              version_id: occ.source_version_id,
              page_id: page?.id ?? null,
              page_index: page?.page_index ?? null,
              page_label_ar: page ? pageDisplayLabel(page) : null,
              region_id: (fromJson<string[]>(occ.region_ids_json, []) ?? [])[0] ?? null,
            }
          : null,
        origin,
        source_type: occ?.source_type ?? null,
        source_title: occ ? clean(occ.title) : null,
        is_evidence: false,
      },
    });
  }
  return out;
}

// ───────── owner content (notes, generated, transcripts) ─────────
interface OwnerHit {
  entity_type: string;
  entity_id: string;
  origin: string;
  text: string;
  rank: number;
}

function ownerContentHits(ctx: AppContext, match: string, entityTypes: string[] | null, origins: string[] | null, fetch: number): OwnerHit[] {
  const where: string[] = ['owner_content_fts MATCH ?'];
  const params: unknown[] = [match];
  if (entityTypes) {
    where.push(`entity_type IN (${entityTypes.map(() => '?').join(',')})`);
    params.push(...entityTypes);
  }
  if (origins) {
    where.push(`origin IN (${origins.map(() => '?').join(',')})`);
    params.push(...origins);
  }
  return ctx.db.all<OwnerHit>(
    `SELECT entity_type, entity_id, origin, text, bm25(owner_content_fts) AS rank FROM owner_content_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
    [...params, fetch],
  );
}

function sourcePasses(ctx: AppContext, p: SearchParams, sourceId: string | null): boolean {
  if (!sourceId) return !(p.source_type || p.source_id || p.node_id);
  const s = ctx.db.get<{ deleted_at: number | null; source_type: SourceType; node_id: string | null; subject_node_id: string | null; course_node_id: string | null }>(
    'SELECT deleted_at, source_type, node_id, subject_node_id, course_node_id FROM source WHERE id = ?',
    [sourceId],
  );
  if (!s || s.deleted_at !== null) return false;
  if (p.source_type && s.source_type !== p.source_type) return false;
  if (p.source_id && sourceId !== p.source_id) return false;
  if (p.node_id && !inSubtree(ctx, p.node_id, [s.node_id, s.subject_node_id, s.course_node_id])) return false;
  return true;
}

function inSubtree(ctx: AppContext, rootId: string, nodeIds: Array<string | null>): boolean {
  const ids = nodeIds.filter((x): x is string => !!x);
  if (ids.length === 0) return false;
  if (ids.includes(rootId)) return true;
  const r = ctx.db.get<{ x: number }>(
    `WITH RECURSIVE up(id, parent_id) AS (
       SELECT id, parent_id FROM library_node WHERE id IN (${ids.map(() => '?').join(',')})
       UNION SELECT n.id, n.parent_id FROM library_node n JOIN up ON n.id = up.parent_id
     ) SELECT 1 AS x FROM up WHERE id = ? LIMIT 1`,
    [...ids, rootId],
  );
  return !!r;
}

function searchNotes(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const out: Scored[] = [];
  for (const h of ownerContentHits(ctx, match, ['note'], null, fetch)) {
    const n = ctx.db.get<{ id: string; title: string | null; body_json: string; source_id: string | null; node_id: string | null; anchor_json: string | null; origin: string; deleted_at: number | null }>(
      'SELECT id, title, body_json, source_id, node_id, anchor_json, origin, deleted_at FROM note WHERE id = ?',
      [h.entity_id],
    );
    if (!n || n.deleted_at !== null) continue;
    if (n.source_id) {
      if (!sourcePasses(ctx, p, n.source_id)) continue;
    } else {
      if (p.source_type || p.source_id) continue; // a free note cannot match a source filter
      if (p.node_id && !inSubtree(ctx, p.node_id, [n.node_id])) continue;
    }
    const body = richTextToPlain(fromJson<RichText>(n.body_json));
    const text = [clean(n.title), body].filter(Boolean).join('\n');
    const hs = hl(text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const origin: SearchOrigin = n.origin === 'ai_answer' ? 'generated' : n.origin === 'handwriting_recognition' ? 'recognized' : 'owner_note';
    const anchor = fromJson<{ type?: string; source_id?: string; version_id?: string; page_id?: string; page_index?: number }>(n.anchor_json);
    let location: SearchLocation | null = null;
    let sourceTitle: string | null = null;
    let sourceType: SourceType | null = null;
    if (n.source_id) {
      const s = ctx.db.get<{ title: string; source_type: SourceType }>('SELECT title, source_type FROM source WHERE id = ?', [n.source_id]);
      sourceTitle = s ? clean(s.title) : null;
      sourceType = s?.source_type ?? null;
      const page = anchor?.page_id ? ctx.db.get<PageForLabel & { id: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE id = ?', [anchor.page_id]) : undefined;
      location = {
        source_id: n.source_id,
        version_id: anchor?.version_id ?? null,
        page_id: page?.id ?? null,
        page_index: page?.page_index ?? null,
        page_label_ar: page ? pageDisplayLabel(page) : null,
        region_id: null,
      };
    }
    out.push({
      group: GROUP[origin],
      rank: h.rank,
      result: {
        type: 'notes',
        id: n.id,
        title: clean(n.title) || (sourceTitle ? `ملاحظة على «${sourceTitle}»` : 'ملاحظة'),
        snippet: makeSnippet(text, hs),
        location,
        origin,
        source_type: sourceType,
        source_title: sourceTitle,
        is_evidence: false,
      },
    });
  }
  return out;
}

function generatedText(ctx: AppContext, entityType: string, entityId: string): { title: string; text: string; sourceId: string | null } | null {
  if (entityType === 'artifact') {
    const a = ctx.db.get<{ title: string | null; kind: string; primary_source_id: string | null }>('SELECT title, kind, primary_source_id FROM artifact WHERE id = ?', [entityId]);
    if (!a) return null;
    const blocks = ctx.db.all<{ content_json: string }>('SELECT content_json FROM content_block WHERE artifact_id = ? ORDER BY ord LIMIT 200', [entityId]);
    return { title: clean(a.title) || 'محتوى مولَّد', text: blocks.map((b) => richTextToPlain(fromJson<RichText>(b.content_json))).join('\n'), sourceId: a.primary_source_id };
  }
  if (entityType === 'content_block') {
    const b = ctx.db.get<{ content_json: string; title: string | null; primary_source_id: string | null }>(
      'SELECT b.content_json, a.title, a.primary_source_id FROM content_block b JOIN artifact a ON a.id = b.artifact_id WHERE b.id = ?',
      [entityId],
    );
    if (!b) return null;
    return { title: clean(b.title) || 'كتاب الدراسة', text: richTextToPlain(fromJson<RichText>(b.content_json)), sourceId: b.primary_source_id };
  }
  if (entityType === 'message') {
    const m = ctx.db.get<{ content_json: string; source_id: string | null }>(
      'SELECT m.content_json, t.source_id FROM message m JOIN contextual_thread t ON t.id = m.thread_id WHERE m.id = ?',
      [entityId],
    );
    if (!m) return null;
    return { title: 'إجابة محادثة', text: richTextToPlain(fromJson<RichText>(m.content_json)), sourceId: m.source_id };
  }
  return null;
}

function searchGenerated(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const out: Scored[] = [];
  for (const h of ownerContentHits(ctx, match, ['artifact', 'content_block', 'message'], ['generated'], fetch)) {
    const g = generatedText(ctx, h.entity_type, h.entity_id);
    if (!g) continue;
    if (!sourcePasses(ctx, p, g.sourceId)) continue;
    const text = g.text || h.text;
    const hs = hl(text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const s = g.sourceId ? ctx.db.get<{ title: string; source_type: SourceType }>('SELECT title, source_type FROM source WHERE id = ?', [g.sourceId]) : undefined;
    out.push({
      group: 2,
      rank: h.rank,
      result: {
        type: 'generated',
        id: h.entity_id,
        title: g.title,
        snippet: makeSnippet(text, hs),
        location: g.sourceId ? { source_id: g.sourceId, version_id: null, page_id: null, page_index: null, page_label_ar: null, region_id: null } : null,
        origin: 'generated',
        source_type: s?.source_type ?? null,
        source_title: s ? clean(s.title) : null,
        is_evidence: false,
      },
    });
  }
  return out;
}

/**
 * The real origin of a transcript hit (the segment's own `origin`): typed by the owner, imported from a subtitle
 * file, or machine-recognized. A segment the owner corrected shows (and is searched by) the owner's text.
 */
export function transcriptOrigin(seg: { origin: string; corrected_text: string | null }): SearchOrigin {
  if (seg.corrected_text !== null) return 'owner_typed';
  if (seg.origin === 'transcription') return 'recognized';
  if (seg.origin === 'imported_vtt' || seg.origin === 'imported_srt') return 'imported';
  return 'owner_typed';
}

function searchTranscripts(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const out: Scored[] = [];
  for (const h of ownerContentHits(ctx, match, ['transcript_segment'], null, fetch)) {
    const seg = ctx.db.get<{ text: string; corrected_text: string | null; start_ms: number; source_id: string; origin: string }>(
      'SELECT t.text, t.corrected_text, t.start_ms, t.origin, a.source_id FROM transcript_segment t JOIN audio_asset a ON a.id = t.audio_id WHERE t.id = ?',
      [h.entity_id],
    );
    if (!seg || !sourcePasses(ctx, p, seg.source_id)) continue;
    const text = seg.corrected_text ?? seg.text;
    const hs = hl(text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const s = ctx.db.get<{ title: string; source_type: SourceType }>('SELECT title, source_type FROM source WHERE id = ?', [seg.source_id]);
    out.push({
      group: 1,
      rank: h.rank,
      result: {
        type: 'transcripts',
        id: h.entity_id,
        title: s ? clean(s.title) : 'تفريغ صوتي',
        snippet: makeSnippet(text, hs),
        location: { source_id: seg.source_id, version_id: null, page_id: null, page_index: null, page_label_ar: locatorLabelAr(null, { start_ms: seg.start_ms }), region_id: null },
        origin: transcriptOrigin(seg),
        source_type: s?.source_type ?? null,
        source_title: s ? clean(s.title) : null,
        is_evidence: false,
      },
    });
  }
  return out;
}

/** (track F4) Handwriting readings of the owner's strokes on source pages and note pages. */
function searchHandwriting(ctx: AppContext, p: SearchParams, match: string, fetch: number, hl: Highlighter, counters: { exactRejected: number }): Scored[] {
  const out: Scored[] = [];
  for (const h of ownerContentHits(ctx, match, ['ink_recognition'], null, fetch)) {
    const r = ctx.db.get<{
      text: string;
      corrected_text: string | null;
      source_id: string | null;
      version_id: string | null;
      page_id: string | null;
      note_page_id: string | null;
      annotation_ids_json: string;
      deleted_at: number | null;
      purpose: string;
    }>('SELECT text, corrected_text, source_id, version_id, page_id, note_page_id, annotation_ids_json, deleted_at, purpose FROM ink_recognition WHERE id = ?', [h.entity_id]);
    if (!r || r.deleted_at !== null || r.purpose !== 'page_ink') continue;
    // the reading stands for writing that still exists: when every stroke it read was erased, it is not a hit
    const ids = fromJson<string[]>(r.annotation_ids_json, []) ?? [];
    if (ids.length > 0) {
      const known = ctx.db.all<{ deleted_at: number | null }>(`SELECT deleted_at FROM annotation WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      if (known.length > 0 && known.every((k) => k.deleted_at !== null)) continue;
    }
    if (r.note_page_id) {
      const np = ctx.db.get<{ deleted_at: number | null; source_id: string | null; node_id: string | null }>('SELECT deleted_at, source_id, node_id FROM note_page WHERE id = ?', [r.note_page_id]);
      if (!np || np.deleted_at !== null) continue;
      if (np.source_id ? !sourcePasses(ctx, p, np.source_id) : p.source_type || p.source_id || (p.node_id && !inSubtree(ctx, p.node_id, [np.node_id]))) continue;
    } else if (!sourcePasses(ctx, p, r.source_id)) continue;
    const text = r.corrected_text ?? r.text;
    const hs = hl(text);
    if (p.mode === 'exact' && hs.length === 0) {
      counters.exactRejected++;
      continue;
    }
    const s = r.source_id ? ctx.db.get<{ title: string; source_type: SourceType }>('SELECT title, source_type FROM source WHERE id = ?', [r.source_id]) : undefined;
    const page = r.page_id ? ctx.db.get<PageForLabel & { id: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE id = ?', [r.page_id]) : undefined;
    const origin: SearchOrigin = r.corrected_text !== null ? 'owner_typed' : 'recognized';
    out.push({
      group: 1,
      rank: h.rank,
      result: {
        type: 'handwriting',
        id: h.entity_id,
        title: s ? `خط يدي على «${clean(s.title)}»` : 'خط يدي في صفحة ملاحظات',
        snippet: makeSnippet(text, hs),
        location: r.source_id
          ? { source_id: r.source_id, version_id: r.version_id, page_id: page?.id ?? null, page_index: page?.page_index ?? null, page_label_ar: page ? pageDisplayLabel(page) : null, region_id: null }
          : null,
        origin,
        source_type: s?.source_type ?? null,
        source_title: s ? clean(s.title) : null,
        is_evidence: false,
      },
    });
  }
  return out;
}

function tableHasRows(ctx: AppContext, sql: string): boolean {
  try {
    return !!ctx.db.get(sql);
  } catch {
    return false;
  }
}

export function universalSearch(ctx: AppContext, p: SearchParams): SearchResponse {
  const built = buildQuery(ctx.db, p.q);
  const notices: string[] = [];
  const types = p.types.length ? p.types : [...SEARCH_RESULT_TYPES];
  // exact mode searches the phrase as typed: dictionary expansions are NOT applied there, so none are reported
  const base: SearchResponse = { query: p.q, mode: p.mode, results: [], next_cursor: null, expansions: p.mode === 'exact' ? [] : built.expansions, searched_types: types, notices_ar: notices };
  const match = p.mode === 'exact' ? built.phrase : built.and;
  if (!match) {
    notices.push('اكتب كلمة واحدة على الأقل للبحث.');
    return base;
  }
  const fetch = Math.min(p.offset + p.limit + 1, 1000) * (p.mode === 'exact' ? 3 : 1);
  const hl = highlighter(p.mode, p.q, built);
  const counters = { exactRejected: 0 };
  const all: Scored[] = [];
  if (types.includes('chunks')) all.push(...searchChunks(ctx, p, match, fetch, hl, counters));
  if (types.includes('questions')) {
    if (!tableHasRows(ctx, 'SELECT 1 AS x FROM question_fts LIMIT 1')) notices.push('لا توجد أسئلة مفهرسة للبحث بعد.');
    else all.push(...searchQuestions(ctx, p, match, fetch, hl, counters));
  }
  if (types.includes('notes')) all.push(...searchNotes(ctx, p, match, fetch, hl, counters));
  if (types.includes('generated')) all.push(...searchGenerated(ctx, p, match, fetch, hl, counters));
  if (types.includes('transcripts')) {
    if (!tableHasRows(ctx, `SELECT 1 AS x FROM owner_content_fts WHERE entity_type = 'transcript_segment' LIMIT 1`)) notices.push('التفريغ الصوتي غير متاح بعد، فلا يوجد ما يُبحث فيه من التسجيلات.');
    else all.push(...searchTranscripts(ctx, p, match, fetch, hl, counters));
  }
  if (types.includes('handwriting')) all.push(...searchHandwriting(ctx, p, match, fetch, hl, counters));
  // sources first, then the owner's own notes, then generated content (never ranked as a source)
  const typeOrder: Record<SearchResultType, number> = { chunks: 0, questions: 1, transcripts: 2, notes: 3, handwriting: 4, generated: 5 };
  all.sort((a, b) => a.group - b.group || a.rank - b.rank || typeOrder[a.result.type] - typeOrder[b.result.type]);
  const page = all.slice(p.offset, p.offset + p.limit);
  base.results = page.map((s) => s.result);
  base.next_cursor = all.length > p.offset + p.limit ? encodeCursor(p.offset + p.limit) : null;
  if (p.mode === 'exact') base.exact_rejected = counters.exactRejected;
  if (all.length === 0 && built.expansions.length === 0 && p.mode === 'keyword') {
    notices.push('لا نتائج. جرّب كلمات أقل، أو أضف مرادفًا أو اختصارًا إلى قاموس مصطلحاتك.');
  }
  return base;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0 && v.o <= 100_000 ? v.o : 0;
  } catch {
    return 0;
  }
}
