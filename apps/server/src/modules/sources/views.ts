// Row types + row → API view mappers for the library & sources modules (packages/shared/src/sources.ts).
import type {
  LibraryNodeKind,
  LibraryNodeView,
  NodeCover,
  Pagination,
  ProcessingSummary,
  SourceFormat,
  SourcePageView,
  SourceRegionView,
  SourceSummary,
  SourceType,
  SourceVersionView,
  TagView,
} from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';

export interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: LibraryNodeKind;
  title: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  cover_json: string | null;
  template: string | null;
  sort_order: number;
  sort_mode: LibraryNodeView['sort_mode'];
  is_favorite: number;
  archived_at: number | null;
  deleted_at: number | null;
  trash_root_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SourceRow {
  id: string;
  title: string;
  source_type: SourceType;
  source_type_origin: 'auto' | 'owner';
  language: string | null;
  node_id: string | null;
  subject_node_id: string | null;
  course_node_id: string | null;
  lecture_kind: SourceSummary['lecture_kind'];
  lecture_kind_origin: SourceSummary['lecture_kind_origin'];
  edition: string | null;
  authors_json: string | null;
  publication_date: string | null;
  original_url: string | null;
  metadata_status: 'unknown' | 'partial' | 'owner_confirmed';
  priority: number;
  selection_reason: string | null;
  processing_status: SourceSummary['processing_status'];
  current_version_id: string | null;
  frozen_version_id: string | null;
  sort_order: number;
  is_favorite: number;
  last_opened_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  trash_root_id: string | null;
  created_at: number;
  updated_at: number;
}

/** source row joined with its current (cv_*) and active (av_*) versions. */
export interface SourceJoinedRow extends SourceRow {
  cv_status: SourceSummary['processing_status'] | null;
  av_format: SourceFormat | null;
  av_page_count: number | null;
}

export interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  kind: SourceVersionView['kind'];
  derived_from_version_id: string | null;
  file_id: string | null;
  original_file_id: string | null;
  display_file_id: string | null;
  content_hash: string;
  mime: string;
  file_name: string | null;
  format: SourceFormat;
  page_count: number | null;
  pagination: Pagination;
  processing_status: SourceVersionView['processing_status'];
  processing_summary_json: string | null;
  note: string | null;
  created_at: number;
}

export interface PageRow {
  id: string;
  version_id: string;
  page_index: number;
  printed_label: string | null;
  printed_label_origin: SourcePageView['printed_label_origin'];
  kind: SourcePageView['kind'];
  width: number | null;
  height: number | null;
  unit: SourcePageView['unit'];
  rotation: number;
  text_status: SourcePageView['text_status'];
  ocr_confidence: number | null;
  has_images: number;
  processing_status: SourcePageView['processing_status'];
  error_code: string | null;
  error_detail: string | null;
  thumbnail_file_id: string | null;
  render_file_id: string | null;
  section_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface RegionRow {
  id: string;
  version_id: string;
  page_id: string | null;
  parent_region_id: string | null;
  kind: SourceRegionView['kind'];
  reading_order: number;
  bbox_json: string | null;
  locator_json: string | null;
  text: string | null;
  text_origin: SourceRegionView['text_origin'];
  lang: string | null;
  confidence: number | null;
  structure_json: string | null;
  status: SourceRegionView['status'];
}

/** SELECT list for SourceJoinedRow (source s, current version cv, active version av). */
export const SOURCE_JOINED_SELECT = `
  SELECT s.*, cv.processing_status AS cv_status, av.format AS av_format, av.page_count AS av_page_count
  FROM source s
  LEFT JOIN source_version cv ON cv.id = s.current_version_id
  LEFT JOIN source_version av ON av.id = COALESCE(s.frozen_version_id, s.current_version_id)`;

/** Tags of every entity of one type, grouped by entity id (one query). */
export function tagsByEntity(db: Db, entityType: 'library_node' | 'source', ids?: readonly string[]): Map<string, TagView[]> {
  const out = new Map<string, TagView[]>();
  if (ids && ids.length === 0) return out;
  const rows = db.all<{ entity_id: string; id: string; name: string; color: string | null }>(
    `SELECT tl.entity_id, t.id, t.name, t.color FROM tag_link tl JOIN tag t ON t.id = tl.tag_id
     WHERE tl.entity_type = ? ${ids ? `AND tl.entity_id IN (${ids.map(() => '?').join(',')})` : ''}
     ORDER BY t.name COLLATE NOCASE`,
    ids ? [entityType, ...ids] : [entityType],
  );
  for (const r of rows) {
    const list = out.get(r.entity_id) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.entity_id, list);
  }
  return out;
}

export function toNodeView(r: NodeRow, tags: TagView[] = []): LibraryNodeView {
  return {
    id: r.id,
    parent_id: r.parent_id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    color: r.color,
    icon: r.icon,
    cover: fromJson<NodeCover>(r.cover_json),
    template: r.template,
    sort_order: r.sort_order,
    sort_mode: r.sort_mode,
    is_favorite: r.is_favorite === 1,
    archived_at: r.archived_at,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    tags,
  };
}

export function toSourceSummary(r: SourceJoinedRow, tags: TagView[] = []): SourceSummary {
  return {
    id: r.id,
    title: r.title,
    source_type: r.source_type,
    node_id: r.node_id,
    subject_node_id: r.subject_node_id,
    course_node_id: r.course_node_id,
    lecture_kind: r.lecture_kind,
    lecture_kind_origin: r.lecture_kind_origin,
    // the latest version is what is being processed; fall back to the source column
    processing_status: r.cv_status ?? r.processing_status,
    current_version_id: r.current_version_id,
    frozen_version_id: r.frozen_version_id,
    active_version_id: r.frozen_version_id ?? r.current_version_id,
    format: r.av_format,
    page_count: r.av_page_count,
    is_favorite: r.is_favorite === 1,
    last_opened_at: r.last_opened_at,
    archived_at: r.archived_at,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    tags,
  };
}

export function toVersionView(v: VersionRow, frozenVersionId: string | null): SourceVersionView {
  return {
    id: v.id,
    source_id: v.source_id,
    version_no: v.version_no,
    kind: v.kind,
    format: v.format,
    pagination: v.pagination,
    mime: v.mime,
    file_name: v.file_name,
    file_id: v.file_id,
    original_file_id: v.original_file_id,
    // a PDF renders itself; other formats only when processing produced a fixed rendering
    display_file_id: v.display_file_id ?? (v.format === 'pdf' ? v.file_id : null),
    content_hash: v.content_hash,
    page_count: v.page_count,
    processing_status: v.processing_status,
    processing_summary: fromJson<ProcessingSummary>(v.processing_summary_json),
    is_frozen: frozenVersionId === v.id,
    created_at: v.created_at,
    note: v.note,
  };
}

export function toPageView(p: PageRow): SourcePageView {
  return {
    id: p.id,
    version_id: p.version_id,
    page_index: p.page_index,
    printed_label: p.printed_label,
    printed_label_origin: p.printed_label_origin,
    kind: p.kind,
    width: p.width,
    height: p.height,
    unit: p.unit,
    rotation: p.rotation,
    text_status: p.text_status,
    ocr_confidence: p.ocr_confidence,
    has_images: p.has_images === 1,
    processing_status: p.processing_status,
    error_code: p.error_code,
    error_detail_ar: p.error_detail,
    thumbnail_file_id: p.thumbnail_file_id,
    render_file_id: p.render_file_id,
    section_key: p.section_key,
  };
}

export function toRegionView(r: RegionRow): SourceRegionView {
  return {
    id: r.id,
    version_id: r.version_id,
    page_id: r.page_id,
    parent_region_id: r.parent_region_id,
    kind: r.kind,
    reading_order: r.reading_order,
    bbox: fromJson(r.bbox_json),
    locator: fromJson(r.locator_json),
    text: r.text,
    text_origin: r.text_origin,
    lang: r.lang,
    confidence: r.confidence,
    structure: fromJson(r.structure_json),
    status: r.status,
  };
}

/** `IN (?, ?, …)` placeholder list. Callers must not pass an empty list. */
export function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
