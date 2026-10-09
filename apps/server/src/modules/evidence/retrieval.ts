// Scope-locked retrieval (§08, §09, §52, ARCHITECTURE §3.7).
//
//  * `scope` is REQUIRED (no default "everything"). Every SQL statement filters by scope.versionIds in the
//    same statement as the FTS MATCH, so out-of-scope chunks never reach bm25 ranking or LIMIT (AC-05).
//  * Anchor regions (the owner's selection) + their reading-order neighbours + the previous / next chunks
//    come first; anchors outside the scope are dropped and reported (never silently widened).
//  * Keyword search: chunk_fts (ml_norm-normalized) with owner-dictionary expansion only (terms.ts).
//    AND first, then OR to fill up to k.
//  * Source priority per task (owner settings) decides where the search STARTS (ordering), never who wins
//    a conflict: every in-scope source with a hit keeps at least one candidate, so a contradicting reference
//    is never pushed out by the lecture.
//  * Semantic retrieval (embeddings) is not available → reported as not used, with the reason.
//  * `searched` reports exactly what was searched: versions, pages ready vs unreadable vs not processed, so a
//    caller can abstain precisely («لم أجده في 4 صفحات معالَجة؛ صفحة واحدة غير مقروءة»).
import type { AbstainReason, ResolvedScope, ScopeOrigin, SearchedReport, SearchedVersionReport, SourceScope, SourceType } from '@medlevo/shared';
import { ABSTAIN_REASON_LABELS_AR } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { buildQuery, groupCoverage, type Expansion } from './terms';

export const RETRIEVAL_PURPOSES = ['lecture_explanation', 'source_question_practice', 'clinical_expansion', 'general'] as const;
export type RetrievalPurpose = (typeof RETRIEVAL_PURPOSES)[number];

export interface RetrievalAnchor {
  /** regions the owner selected (must belong to in-scope versions) */
  region_ids?: string[];
  /** a whole page (its text regions) when no regions were selected */
  page_id?: string | null;
}

export interface RetrieveRequest {
  scope: ResolvedScope;
  query: string;
  anchor?: RetrievalAnchor | null;
  /** max keyword candidates (anchor candidates are always returned), default 8, max 40 */
  k?: number;
  purpose: RetrievalPurpose;
  /** reading-order neighbours on each side of an anchor region (default 2, max 5) */
  neighbours?: number;
}

export type CandidateKind = 'anchor_region' | 'neighbour_region' | 'adjacent_chunk' | 'keyword_chunk';

export interface RetrievalCandidate {
  /** `region:<id>` or `chunk:<id>` */
  key: string;
  kind: CandidateKind;
  source_id: string;
  source_title: string;
  source_type: SourceType;
  version_id: string;
  /** origin of the source in the scope (lecture / reference / my_notes) */
  scope_origin: ScopeOrigin;
  /** 0 = searched first (owner priority for this task) */
  priority_tier: number;
  /** My Notes are a low-assurance personal source (§09) */
  low_assurance: boolean;
  chunk_id: string | null;
  region_ids: string[];
  page_ids: string[];
  heading_path: string | null;
  /** original text (logical order); untrusted data for any model */
  text: string;
  /** bm25 rank (lower = better) for keyword chunks */
  rank: number | null;
}

export interface RetrieveResult {
  candidates: RetrievalCandidate[];
  searched: SearchedReport;
  query: { mode: 'and' | 'or' | 'none'; expansions: Expansion[]; tokens: string[] };
  /** anchors dropped because they are outside the scope (or no longer exist) */
  dropped_anchor_region_ids: string[];
  /** the anchor page, when it was dropped (outside the scope, or missing) — never silently ignored */
  dropped_anchor_page_id: string | null;
}

const SEMANTIC_REASON_AR =
  'لم يُستخدم البحث الدلالي (embeddings): لا يوجد مزود embeddings مضبوط ولا فهرس دلالي في هذا الإصدار؛ استُخدم البحث بالكلمات داخل النطاق فقط.';

interface SourceMeta {
  source_id: string;
  title: string;
  source_type: SourceType;
}

function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function scopeSources(ctx: AppContext, scope: ResolvedScope): Map<string, SourceMeta & { version_id: string }> {
  const out = new Map<string, SourceMeta & { version_id: string }>();
  if (scope.versionIds.length === 0) return out;
  const rows = ctx.db.all<{ version_id: string; source_id: string; title: string; source_type: SourceType }>(
    `SELECT v.id AS version_id, s.id AS source_id, s.title, s.source_type FROM source_version v JOIN source s ON s.id = v.source_id
      WHERE v.id IN (${inList(scope.versionIds.length)})`,
    scope.versionIds,
  );
  for (const r of rows) out.set(r.version_id, { version_id: r.version_id, source_id: r.source_id, title: r.title.replace(/[\r\n\t]+/g, ' ').trim(), source_type: r.source_type });
  return out;
}

function originOf(scope: ResolvedScope & { origins?: Record<string, ScopeOrigin> }, sourceId: string, type: SourceType): ScopeOrigin {
  const o = scope.origins?.[sourceId];
  if (o) return o;
  if (type === 'my_notes') return 'my_notes';
  if (scope.mode === 'lecture_only') return 'lecture';
  if (scope.mode === 'references_only') return 'reference';
  return sourceId === scope.sourceIds[0] ? 'lecture' : 'reference';
}

/** Priority tiers from the owner's settings for this task (§09). */
export function priorityTiers(ctx: AppContext, purpose: RetrievalPurpose): (type: SourceType) => number {
  const s = ctx.settings.get();
  const list: string[] =
    purpose === 'general' ? s.source_priority.lecture_explanation : (s.source_priority as Record<string, string[]>)[purpose] ?? s.source_priority.lecture_explanation;
  return (type) => {
    if (type === 'my_notes') return list.length + 1; // low assurance: never ahead of an academic source
    const i = list.indexOf(type);
    return i >= 0 ? i : list.length;
  };
}

// ───────── searched report ─────────
export function searchedReport(ctx: AppContext, scope: ResolvedScope, expansions: Expansion[] = []): SearchedReport {
  const meta = scopeSources(ctx, scope);
  const versions: SearchedVersionReport[] = [];
  for (const versionId of scope.versionIds) {
    const m = meta.get(versionId);
    if (!m) continue;
    const v = ctx.db.get<{ page_count: number | null }>('SELECT page_count FROM source_version WHERE id = ?', [versionId]);
    const c = ctx.db.get<{ total: number; ready: number; unreadable: number; unprocessed: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN processing_status IN ('ready','needs_review') AND text_status NOT IN ('no_text_found','needs_ocr','failed','pending') THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN processing_status = 'failed' OR text_status IN ('no_text_found','needs_ocr','failed') THEN 1 ELSE 0 END) AS unreadable,
              SUM(CASE WHEN processing_status IN ('pending','processing','skipped') AND text_status NOT IN ('no_text_found','needs_ocr','failed') THEN 1 ELSE 0 END) AS unprocessed
         FROM source_page WHERE version_id = ?`,
      [versionId],
    )!;
    const known = c.total;
    const total = Math.max(known, v?.page_count ?? 0);
    versions.push({
      version_id: versionId,
      source_id: m.source_id,
      source_title: m.title,
      source_type: m.source_type,
      pages_total: total,
      pages_ready: c.ready ?? 0,
      pages_unreadable: c.unreadable ?? 0,
      // pages the file has but processing has not created yet count as not processed
      pages_unprocessed: (c.unprocessed ?? 0) + Math.max(0, total - known),
    });
  }
  const sum = (k: 'pages_ready' | 'pages_unreadable' | 'pages_unprocessed') => versions.reduce((n, v) => n + v[k], 0);
  const ready = sum('pages_ready');
  const unreadable = sum('pages_unreadable');
  const unprocessed = sum('pages_unprocessed');
  return {
    versions,
    pages_ready: ready,
    pages_unreadable: unreadable,
    pages_unprocessed: unprocessed,
    summary_ar: searchedSummaryAr(versions.length, ready, unreadable, unprocessed),
    semantic: { used: false, reason_ar: SEMANTIC_REASON_AR },
    expansions,
  };
}

/** Arabic count phrase with number agreement: «صفحة واحدة», «صفحتان», «3 صفحات», «11 صفحة». */
export function pagesAr(n: number): string {
  if (n === 1) return 'صفحة واحدة';
  if (n === 2) return 'صفحتان';
  if (n >= 3 && n <= 10) return `${n} صفحات`;
  return `${n} صفحة`;
}

function sourcesAr(n: number): string {
  if (n === 1) return 'مصدر واحد';
  if (n === 2) return 'مصدرين';
  if (n >= 3 && n <= 10) return `${n} مصادر`;
  return `${n} مصدرًا`;
}

export function searchedSummaryAr(nVersions: number, ready: number, unreadable: number, unprocessed: number): string {
  const parts = [`بُحث في ${pagesAr(ready)} معالَجة من ${sourcesAr(nVersions)} ضمن النطاق`];
  if (unreadable > 0) parts.push(`${pagesAr(unreadable)} غير مقروءة`);
  if (unprocessed > 0) parts.push(`${pagesAr(unprocessed)} لم تكتمل معالجتها بعد`);
  return parts.join('؛ ') + '.';
}

// ───────── retrieval ─────────
interface ChunkRow {
  id: string;
  version_id: string;
  source_id: string;
  heading_path: string | null;
  text: string;
  region_ids_json: string;
  page_ids_json: string;
  prev_chunk_id: string | null;
  next_chunk_id: string | null;
  rank: number;
}

interface RegionRow {
  id: string;
  version_id: string;
  page_id: string | null;
  kind: string;
  reading_order: number;
  text: string | null;
}

// citable = source text: never layout furniture, rejected extractions or model-written (vision) descriptions
const CITABLE_REGION = `kind NOT IN ('header','footer','table_cell') AND status <> 'rejected' AND COALESCE(text_origin, '') <> 'vision' AND text IS NOT NULL AND trim(text) <> ''`;

export function retrieve(ctx: AppContext, req: RetrieveRequest): RetrieveResult {
  const scope = req.scope;
  if (!scope || !Array.isArray(scope.versionIds)) throw new AppError('OUT_OF_SCOPE', 'الاسترجاع يحتاج نطاق مصادر محسومًا (Source Lock).', 409);
  const k = Math.min(Math.max(req.k ?? 8, 1), 40);
  const neighbours = Math.min(Math.max(req.neighbours ?? 2, 0), 5);
  const versionIds = [...new Set(scope.versionIds)];
  const meta = scopeSources(ctx, scope);
  const tierOf = priorityTiers(ctx, req.purpose);
  const out: RetrievalCandidate[] = [];
  const seen = new Set<string>();
  const coveredRegions = new Set<string>();
  const dropped: string[] = [];
  let droppedPage: string | null = null;

  const base = (versionId: string) => {
    const m = meta.get(versionId)!;
    return {
      source_id: m.source_id,
      source_title: m.title,
      source_type: m.source_type,
      version_id: versionId,
      scope_origin: originOf(scope, m.source_id, m.source_type),
      priority_tier: tierOf(m.source_type),
      low_assurance: m.source_type === 'my_notes',
    };
  };
  const pushRegion = (r: RegionRow, kind: CandidateKind) => {
    const key = `region:${r.id}`;
    if (seen.has(key) || !r.text?.trim()) return;
    seen.add(key);
    coveredRegions.add(r.id);
    out.push({ key, kind, ...base(r.version_id), chunk_id: null, region_ids: [r.id], page_ids: r.page_id ? [r.page_id] : [], heading_path: null, text: r.text, rank: null });
  };
  const pushChunk = (c: ChunkRow, kind: CandidateKind, rank: number | null) => {
    const key = `chunk:${c.id}`;
    if (seen.has(key)) return;
    const regionIds = fromJson<string[]>(c.region_ids_json, []) ?? [];
    // a chunk whose regions are all already candidates adds nothing
    if (regionIds.length > 0 && regionIds.every((id) => coveredRegions.has(id))) return;
    seen.add(key);
    for (const id of regionIds) coveredRegions.add(id);
    out.push({
      key,
      kind,
      ...base(c.version_id),
      chunk_id: c.id,
      region_ids: regionIds,
      page_ids: fromJson<string[]>(c.page_ids_json, []) ?? [],
      heading_path: c.heading_path,
      text: c.text,
      rank,
    });
  };

  // 1) anchors (scope-checked), neighbours, adjacent chunks
  if (versionIds.length > 0 && req.anchor) {
    const vIn = inList(versionIds.length);
    let anchors: RegionRow[] = [];
    const wanted = [...new Set(req.anchor.region_ids ?? [])].slice(0, 50);
    if (wanted.length > 0) {
      anchors = ctx.db.all<RegionRow>(
        `SELECT id, version_id, page_id, kind, reading_order, text FROM source_region
          WHERE id IN (${inList(wanted.length)}) AND version_id IN (${vIn})`,
        [...wanted, ...versionIds],
      );
      const found = new Set(anchors.map((a) => a.id));
      for (const id of wanted) if (!found.has(id)) dropped.push(id);
    } else if (req.anchor.page_id) {
      anchors = ctx.db.all<RegionRow>(
        `SELECT id, version_id, page_id, kind, reading_order, text FROM source_region
          WHERE page_id = ? AND version_id IN (${vIn}) AND ${CITABLE_REGION} ORDER BY reading_order LIMIT 60`,
        [req.anchor.page_id, ...versionIds],
      );
      const pageInScope = ctx.db.get<{ x: number }>(`SELECT 1 AS x FROM source_page WHERE id = ? AND version_id IN (${vIn})`, [req.anchor.page_id, ...versionIds]);
      if (!pageInScope) droppedPage = req.anchor.page_id;
    }
    anchors.sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
    for (const a of anchors) pushRegion(a, 'anchor_region');
    if (neighbours > 0) {
      for (const a of anchors) {
        if (!a.page_id) continue;
        const near = ctx.db.all<RegionRow>(
          `SELECT id, version_id, page_id, kind, reading_order, text FROM source_region
            WHERE page_id = ? AND version_id = ? AND ${CITABLE_REGION} AND parent_region_id IS NULL
              AND reading_order BETWEEN ? AND ? AND id <> ?
            ORDER BY ABS(reading_order - ?), reading_order`,
          [a.page_id, a.version_id, a.reading_order - neighbours, a.reading_order + neighbours, a.id, a.reading_order],
        );
        for (const n of near) pushRegion(n, 'neighbour_region');
      }
    }
    // chunks containing the anchors → their previous / next chunks (logical context, §52)
    for (const a of anchors) {
      const holder = ctx.db.get<ChunkRow>(
        `SELECT c.id, c.version_id, c.source_id, c.heading_path, c.text, c.region_ids_json, c.page_ids_json, c.prev_chunk_id, c.next_chunk_id, 0 AS rank
           FROM document_chunk c, json_each(c.region_ids_json) j
          WHERE c.version_id = ? AND j.value = ? LIMIT 1`,
        [a.version_id, a.id],
      );
      if (!holder) continue;
      for (const adjId of [holder.prev_chunk_id, holder.next_chunk_id]) {
        if (!adjId) continue;
        const adj = ctx.db.get<ChunkRow>(
          `SELECT id, version_id, source_id, heading_path, text, region_ids_json, page_ids_json, prev_chunk_id, next_chunk_id, 0 AS rank
             FROM document_chunk WHERE id = ? AND version_id IN (${vIn})`,
          [adjId, ...versionIds],
        );
        if (adj) pushChunk(adj, 'adjacent_chunk', null);
      }
    }
  }

  // 2) keyword retrieval, scope-filtered in SQL before ranking
  const built = buildQuery(ctx.db, req.query ?? '', { dropStopwords: true });
  let mode: RetrieveResult['query']['mode'] = 'none';
  if (versionIds.length > 0 && built.and) {
    const limit = Math.max(k * 4, 20);
    const run = (match: string) =>
      ctx.db.all<ChunkRow>(
        `SELECT c.id, c.version_id, c.source_id, c.heading_path, c.text, c.region_ids_json, c.page_ids_json, c.prev_chunk_id, c.next_chunk_id,
                bm25(chunk_fts) AS rank
           FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid
          WHERE chunk_fts MATCH ? AND c.version_id IN (${inList(versionIds.length)})
          ORDER BY rank LIMIT ?`,
        [match, ...versionIds, limit],
      );
    let hits = run(built.and);
    mode = 'and';
    if (hits.length < k && built.or && built.or !== built.and) {
      // OR hits must still cover at least half of the query terms: a chunk sharing one common word with
      // the question is not a candidate (keeps «not found in N pages» abstentions precise)
      const extra = run(built.or).filter((h) => groupCoverage(built, `${h.heading_path ?? ''} ${h.text}`) >= 0.5);
      const have = new Set(hits.map((h) => h.id));
      hits = [...hits, ...extra.filter((h) => !have.has(h.id))];
      mode = hits.length > 0 ? 'or' : mode;
    }
    // defensive: never let anything outside the scope through (the SQL already filtered)
    const allowed = new Set(versionIds);
    hits = hits.filter((h) => allowed.has(h.version_id));
    const ranked = hits
      .map((h, i) => ({ h, tier: tierOf(meta.get(h.version_id)!.source_type), order: i }))
      .sort((a, b) => a.tier - b.tier || a.order - b.order);
    // priority decides the start, not the winner: every source with a hit keeps its best one, then the
    // remaining slots are filled in priority order
    const bestPerSource = new Map<string, (typeof ranked)[number]>();
    for (const r of ranked) if (!bestPerSource.has(r.h.source_id)) bestPerSource.set(r.h.source_id, r);
    const reserved = new Set(bestPerSource.values());
    const picked = [...reserved];
    const budget = Math.max(k, reserved.size);
    for (const r of ranked) {
      if (picked.length >= budget) break;
      if (!reserved.has(r)) picked.push(r);
    }
    picked.sort((a, b) => a.tier - b.tier || a.order - b.order);
    for (const p of picked) pushChunk(p.h, 'keyword_chunk', p.h.rank);
  }

  return {
    candidates: out,
    searched: searchedReport(ctx, scope, built.expansions),
    query: { mode, expansions: built.expansions, tokens: built.tokens },
    dropped_anchor_region_ids: dropped,
    dropped_anchor_page_id: droppedPage,
  };
}

// ───────── abstention (§12) ─────────
export interface AbstainDecision {
  reason: AbstainReason;
  reason_ar: string;
  detail: string;
  /** an explicit wider scope the owner may choose (never applied automatically, §08) */
  suggest_scope?: SourceScope;
}

/**
 * Specific abstention when retrieval found nothing usable: unreadable/unprocessed pages vs «not found in N
 * processed pages». For a lecture-only scope with linked references, suggests «المحاضرة + المراجع» as an
 * explicit owner action.
 */
export function abstainFor(ctx: AppContext, result: RetrieveResult, scope: ResolvedScope): AbstainDecision | null {
  if (result.candidates.length > 0) return null;
  const s = result.searched;
  if (s.pages_ready === 0 && s.pages_unreadable + s.pages_unprocessed > 0) {
    return { reason: 'unreadable_source', reason_ar: ABSTAIN_REASON_LABELS_AR.unreadable_source, detail: s.summary_ar };
  }
  const decision: AbstainDecision = {
    reason: 'not_found_in_scope',
    reason_ar: ABSTAIN_REASON_LABELS_AR.not_found_in_scope,
    detail: `${s.summary_ar}${s.pages_unreadable + s.pages_unprocessed > 0 ? ' قد تكون المعلومة في الصفحات غير المقروءة.' : ''}`,
  };
  if (scope.mode === 'lecture_only' && scope.sourceIds[0]) {
    const lecture = scope.sourceIds[0];
    // the lecture's references only (incoming «R reference_for lecture» links, same rule as resolveScope)
    const refs = ctx.db.all<{ other: string }>(
      `SELECT l.from_source_id AS other FROM source_link l JOIN source o ON o.id = l.from_source_id
        WHERE l.relation = 'reference_for' AND l.to_source_id = ? AND o.deleted_at IS NULL ORDER BY l.created_at`,
      [lecture],
    );
    if (refs.length > 0) {
      decision.suggest_scope = {
        mode: 'lecture_plus_references',
        lecture_source_id: lecture,
        reference_source_ids: refs.map((r) => r.other),
        version_pins: { ...scope.versionBySource },
        include_my_notes: false,
      };
    }
  }
  return decision;
}
