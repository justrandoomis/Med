// Course Brain — shared reads: course sources (subtree of a library node, course order), study versions, page labels,
// concept views. Reads tables of other modules (allowed); writes only brain-owned rows (see index.ts).
import { BRAIN_SOURCE_TYPES, conceptRoleLabelAr, pageDisplayLabel, type BrainConceptView, type BrainLocation, type ConceptMentionView, type ConceptStatus } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { subtreeIds } from '../library/service';

export const PROCESSED = ['ready', 'partial', 'needs_review'];

export interface SourceLite {
  id: string;
  title: string;
  source_type: string;
  node_id: string | null;
  course_node_id: string | null;
  subject_node_id: string | null;
  current_version_id: string | null;
  frozen_version_id: string | null;
  sort_order: number;
  created_at: number;
}

export interface StudySource extends SourceLite {
  /** frozen version (Source Freeze) else current */
  version_id: string | null;
  processing_status: string | null;
}

const SOURCE_COLS = 'id, title, source_type, node_id, course_node_id, subject_node_id, current_version_id, frozen_version_id, sort_order, created_at';

function withVersion(ctx: AppContext, s: SourceLite): StudySource {
  const versionId = s.frozen_version_id ?? s.current_version_id;
  const v = versionId ? ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [versionId]) : undefined;
  return { ...s, version_id: versionId, processing_status: v?.processing_status ?? null };
}

export function nodeTitle(ctx: AppContext, nodeId: string): { id: string; title: string; kind: string } {
  const n = ctx.db.get<{ id: string; title: string; kind: string; deleted_at: number | null }>('SELECT id, title, kind, deleted_at FROM library_node WHERE id = ?', [nodeId]);
  if (!n || n.deleted_at !== null) throw new AppError('NOT_FOUND', 'المجلد أو الكورس غير موجود.', 404);
  return { id: n.id, title: n.title, kind: n.kind };
}

/**
 * Study sources (lectures, references, textbooks…) inside a library node's subtree, in course order (the library's
 * manual order, then upload order). Trashed / archived-deleted sources are excluded.
 */
export function courseSources(ctx: AppContext, nodeId: string): StudySource[] {
  const ids = subtreeIds(ctx, nodeId);
  if (ids.length === 0) return [];
  const rows = ctx.db.all<SourceLite>(
    `SELECT ${SOURCE_COLS} FROM source WHERE deleted_at IS NULL AND (node_id IN (${ids.map(() => '?').join(',')}) OR course_node_id = ?)
       AND source_type IN (${BRAIN_SOURCE_TYPES.map(() => '?').join(',')})
     ORDER BY sort_order, created_at, id`,
    [...ids, nodeId, ...BRAIN_SOURCE_TYPES],
  );
  return rows.map((r) => withVersion(ctx, r));
}

export function studySource(ctx: AppContext, sourceId: string): StudySource {
  const s = ctx.db.get<SourceLite & { deleted_at: number | null }>(`SELECT ${SOURCE_COLS}, deleted_at FROM source WHERE id = ?`, [sourceId]);
  if (!s || s.deleted_at !== null) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  return withVersion(ctx, s);
}

/** The course group a source belongs to for course-level relations (same rule as question matching). */
export function courseKey(s: Pick<SourceLite, 'course_node_id' | 'subject_node_id' | 'node_id'>): string {
  return s.course_node_id ?? s.subject_node_id ?? s.node_id ?? '__unfiled__';
}

export function sourcesOfCourseKey(ctx: AppContext, key: string): StudySource[] {
  const rows = ctx.db.all<SourceLite>(
    `SELECT ${SOURCE_COLS} FROM source WHERE deleted_at IS NULL AND source_type IN (${BRAIN_SOURCE_TYPES.map(() => '?').join(',')})
     ORDER BY sort_order, created_at, id`,
    [...BRAIN_SOURCE_TYPES],
  );
  return rows.filter((r) => courseKey(r) === key).map((r) => withVersion(ctx, r));
}

// ───────── pages & locations ─────────
export interface PageRow {
  id: string;
  version_id: string;
  page_index: number;
  printed_label: string | null;
  kind: string;
}

export function pageLabelAr(p: Pick<PageRow, 'page_index' | 'printed_label' | 'kind'>): string {
  return pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind as never });
}

export function pagesOf(ctx: AppContext, versionId: string): PageRow[] {
  return ctx.db.all<PageRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]);
}

export function locationOfRegion(ctx: AppContext, regionId: string): BrainLocation | null {
  const r = ctx.db.get<{ region_id: string; version_id: string; source_id: string; source_title: string; page_id: string | null; page_index: number | null; printed_label: string | null; page_kind: string | null }>(
    `SELECT r.id AS region_id, r.version_id, v.source_id, s.title AS source_title, p.id AS page_id, p.page_index, p.printed_label, p.kind AS page_kind
       FROM source_region r JOIN source_version v ON v.id = r.version_id JOIN source s ON s.id = v.source_id LEFT JOIN source_page p ON p.id = r.page_id
      WHERE r.id = ?`,
    [regionId],
  );
  if (!r) return null;
  return {
    source_id: r.source_id,
    source_title: r.source_title,
    version_id: r.version_id,
    page_id: r.page_id,
    page_index: r.page_index,
    page_label_ar: r.page_index !== null ? pageLabelAr({ page_index: r.page_index, printed_label: r.printed_label, kind: r.page_kind ?? 'page' }) : null,
    region_id: r.region_id,
  };
}

/** Reader deep link to a page of a source (exact page id; the workspace's `v` / `page_id` parameters). */
export function readerHref(sourceId: string, versionId: string | null, pageId: string | null): string {
  const q = new URLSearchParams();
  if (versionId) q.set('v', versionId);
  if (pageId) q.set('page_id', pageId);
  const qs = q.toString();
  return `/study/${encodeURIComponent(sourceId)}${qs ? `?${qs}` : ''}`;
}

// ───────── concepts ─────────
export interface ConceptRow {
  id: string;
  name_en: string | null;
  name_ar: string | null;
  kind: string | null;
  origin: 'auto' | 'owner';
  status: ConceptStatus;
  merged_into_id: string | null;
  name_origin: 'auto' | 'owner';
  kind_origin: 'auto' | 'owner';
  owner_note: string | null;
  created_at: number;
  updated_at: number;
}

export function conceptRow(ctx: AppContext, id: string): ConceptRow {
  const r = ctx.db.get<ConceptRow>('SELECT * FROM concept WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'المفهوم غير موجود.', 404);
  return r;
}

export function displayName(c: Pick<ConceptRow, 'name_ar' | 'name_en' | 'id'>): string {
  return c.name_ar || c.name_en || c.id;
}

/** Name shown with both languages when both exist («Shock — الصدمة»). */
export function fullName(c: Pick<ConceptRow, 'name_ar' | 'name_en' | 'id'>): string {
  if (c.name_en && c.name_ar) return `${c.name_en} — ${c.name_ar}`;
  return c.name_en || c.name_ar || c.id;
}

export interface MentionRow {
  id: string;
  concept_id: string;
  region_id: string;
  version_id: string;
  role: string | null;
  support: string | null;
  quote: string | null;
  section: string | null;
  source_id: string;
  source_title: string;
  page_id: string | null;
  page_index: number | null;
  printed_label: string | null;
  page_kind: string | null;
}

export const MENTION_SELECT = `SELECT m.id, m.concept_id, m.region_id, m.version_id, m.role, m.support, m.quote, m.section,
    v.source_id, s.title AS source_title, p.id AS page_id, p.page_index, p.printed_label, p.kind AS page_kind
  FROM concept_mention m JOIN source_version v ON v.id = m.version_id JOIN source s ON s.id = v.source_id
  LEFT JOIN source_region r ON r.id = m.region_id LEFT JOIN source_page p ON p.id = r.page_id`;

export function mentionView(m: MentionRow): ConceptMentionView {
  return {
    id: m.id,
    source_id: m.source_id,
    source_title: m.source_title,
    version_id: m.version_id,
    page_id: m.page_id,
    page_index: m.page_index,
    page_label_ar: m.page_index !== null ? pageLabelAr({ page_index: m.page_index, printed_label: m.printed_label, kind: m.page_kind ?? 'page' }) : null,
    region_id: m.region_id,
    role: m.role ?? '',
    role_label_ar: conceptRoleLabelAr(m.role),
    support: m.support === 'stated' ? 'stated' : 'candidate',
    quote: m.quote,
    section: m.section,
  };
}

export function aliasesOf(ctx: AppContext, conceptId: string): string[] {
  return ctx.db.all<{ alias: string }>('SELECT alias FROM concept_alias WHERE concept_id = ? ORDER BY created_at', [conceptId]).map((a) => a.alias);
}

export function conceptView(ctx: AppContext, c: ConceptRow, mentions: MentionRow[], withMentions = false): BrainConceptView {
  const stated = mentions.filter((m) => m.support === 'stated');
  const roles = [...new Set(stated.map((m) => m.role ?? '').filter(Boolean))];
  return {
    id: c.id,
    name: displayName(c),
    name_en: c.name_en,
    name_ar: c.name_ar,
    kind: c.kind === 'candidate' ? null : c.kind,
    origin: c.origin,
    status: c.status,
    name_origin: c.name_origin,
    aliases: aliasesOf(ctx, c.id),
    roles,
    has_definition: roles.includes('definition') || roles.includes('classification'),
    mention_count: mentions.length,
    lecture_ids: [...new Set(mentions.map((m) => m.source_id))],
    owner_note: c.owner_note,
    updated_at: c.updated_at,
    ...(withMentions ? { mentions: mentions.map(mentionView) } : {}),
  };
}

/** Study version ids of a set of sources (skipping unprocessed ones). */
export function versionIdsOf(sources: StudySource[]): string[] {
  return sources.map((s) => s.version_id).filter((v): v is string => !!v);
}

export function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
