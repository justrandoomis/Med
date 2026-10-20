// Library & Sources API contract (§05, §06, §07, §13). Implemented by the library/sources/processing
// server modules and consumed by the web library, upload, sources, and workspace features.
import type { LibraryNodeKind, LectureKind, PageTextStatus, ProcessingStatus, RegionKind, SourceType } from './enums';
import type { NormBox } from './geometry';

// ───────── library (/api/library) ─────────
export interface TagView {
  id: string;
  name: string;
  color: string | null;
}

export interface NodeCover {
  style: 'plain' | 'linen' | 'grid' | 'dots';
  color: string; // design token name (e.g. 'indigo', 'teal', 'rose', 'amber', 'slate', 'green')
  symbol?: string; // short emoji or icon token
}

export interface LibraryNodeView {
  id: string;
  parent_id: string | null;
  kind: LibraryNodeKind;
  title: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  cover: NodeCover | null;
  template: string | null;
  sort_order: number;
  sort_mode: 'manual' | 'title' | 'updated' | 'created';
  is_favorite: boolean;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  tags: TagView[];
}

export interface LibraryTreeResponse {
  nodes: LibraryNodeView[];
  sources: SourceSummary[];
}

/** Impact preview before a destructive action (trash/purge/move). The UI must show it. */
export interface ImpactReport {
  nodes: number;
  sources: number;
  versions: number;
  pages: number;
  annotations: number;
  notes: number;
  questions: number;
  flashcards: number;
  artifacts: number;
  /** human readable lines, Arabic */
  lines_ar: string[];
  /** required to confirm a permanent delete */
  confirm_token?: string;
}

// ───────── sources (/api/sources) ─────────
export const SOURCE_FORMATS = ['pdf', 'docx', 'pptx', 'image', 'image_set', 'audio', 'text'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];
export type Pagination = 'pages' | 'slides' | 'paragraphs' | 'images' | 'timestamps';

export interface SourceSummary {
  id: string;
  title: string;
  source_type: SourceType;
  node_id: string | null;
  subject_node_id: string | null;
  course_node_id: string | null;
  lecture_kind: LectureKind | null;
  lecture_kind_origin: 'auto' | 'owner' | null;
  processing_status: ProcessingStatus;
  current_version_id: string | null;
  frozen_version_id: string | null;
  /** frozen_version_id ?? current_version_id — the version study tools use */
  active_version_id: string | null;
  format: SourceFormat | null;
  page_count: number | null;
  is_favorite: boolean;
  last_opened_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  tags: TagView[];
}

export interface FailedPageInfo {
  page_index: number;
  printed_label: string | null;
  error_code: string;
  reason_ar: string;
}

/** Real counts only (§13: no fake percentages). */
export interface ProcessingSummary {
  stage: 'queued' | 'inspect' | 'extract' | 'ocr' | 'layout' | 'structure' | 'index' | 'validate' | 'done';
  stage_label_ar: string;
  pages_total: number | null;
  pages_ready: number;
  pages_failed: number;
  pages_needs_review: number;
  pages_ocr: number;
  failed_pages: FailedPageInfo[];
  /** true only when every page is ready (no missing / failed pages) */
  coverage_complete: boolean;
  job_id: string | null;
  updated_at: number;
}

export interface SourceVersionView {
  id: string;
  source_id: string;
  version_no: number;
  kind: 'original' | 'converted' | 'ocr_correction' | 'owner_correction' | 'replacement';
  format: SourceFormat;
  pagination: Pagination;
  mime: string;
  file_name: string | null;
  /** file this version renders from (PDF / DOCX / PPTX / image); null for image_set */
  file_id: string | null;
  /** uploaded original (e.g. .doc before conversion) */
  original_file_id: string | null;
  /** a PDF the reader can render as fixed pages (the PDF itself, or a LibreOffice rendering of PPTX/DOC). null if none. */
  display_file_id: string | null;
  content_hash: string;
  page_count: number | null;
  processing_status: ProcessingStatus;
  processing_summary: ProcessingSummary | null;
  is_frozen: boolean;
  created_at: number;
  note: string | null;
}

export interface SourceLinkView {
  id: string;
  from_source_id: string;
  to_source_id: string;
  relation: 'reference_for' | 'question_source_for' | 'audio_for' | 'same_topic';
  other_title: string;
  other_type: SourceType;
}

export interface SourceDetail extends SourceSummary {
  language: string | null;
  edition: string | null;
  authors: string[] | null;
  publication_date: string | null;
  original_url: string | null;
  metadata_status: 'unknown' | 'partial' | 'owner_confirmed';
  priority: number;
  selection_reason: string | null;
  versions: SourceVersionView[];
  links: SourceLinkView[];
  /** breadcrumb of library nodes from root to node_id */
  path: Array<{ id: string; title: string; kind: LibraryNodeKind }>;
}

export interface SourcePageView {
  id: string;
  version_id: string;
  page_index: number;
  printed_label: string | null;
  printed_label_origin: 'pdf_page_labels' | 'detected_text' | 'owner' | 'slide_number' | null;
  kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment';
  width: number | null;
  height: number | null;
  unit: 'pt' | 'px' | null;
  rotation: number;
  text_status: PageTextStatus;
  ocr_confidence: number | null;
  has_images: boolean;
  processing_status: 'pending' | 'processing' | 'ready' | 'failed' | 'needs_review' | 'skipped';
  error_code: string | null;
  error_detail_ar: string | null;
  thumbnail_file_id: string | null;
  render_file_id: string | null;
  section_key: string | null;
  /**
   * H2: the clockwise quarter turn of the page AS DISPLAYED that its text needed to be read upright (a sideways scan or
   * photo read in rotated trials, or a /Rotate that shows upright text sideways); null = not determined. For picture
   * pages `rotation` (the display rotation) equals it, so the reader shows the picture upright.
   */
  content_rotation?: number | null;
  content_rotation_origin?: 'text_direction' | 'ocr_trials' | null;
  /** EXIF orientation (1–8) of a JPEG page, applied before OCR; null = none */
  image_orientation?: number | null;
  /**
   * Some page of this version carries a printed number (AC-04). A page WITHOUT one is then named by its file
   * position only («الصفحة 1 في الملف») — never «ص 1», which may be the printed number of another page.
   */
  numbered_version?: boolean;
}

export interface SourcePagesResponse {
  version: SourceVersionView;
  pages: SourcePageView[];
}

export interface TableCell {
  r: number;
  c: number;
  rowspan?: number;
  colspan?: number;
  header?: boolean;
  text: string;
  bbox?: NormBox;
}
export interface TableStructure {
  type: 'table';
  rows: number;
  cols: number;
  cells: TableCell[];
  caption_region_id?: string | null;
  /**
   * How the grid was found: ruling lines, aligned digital text, an office table, or (H2) the positions of OCR words on
   * a scanned page — `ocr_aligned` grids are inferred, so they carry `certainty: 'uncertain'`.
   */
  method?: 'ruled' | 'aligned' | 'office' | 'ocr_aligned';
  certainty?: 'uncertain';
}
export interface DiagramStructure {
  type: 'diagram';
  nodes: Array<{ id: string; label: string; bbox?: NormBox; certainty: 'read' | 'uncertain' }>;
  edges: Array<{ from: string; to: string; label?: string; certainty: 'read' | 'uncertain' }>;
  /** e.g. 'labels_ocr_only' when relations were not understood (needs vision) */
  understanding: 'structure_read' | 'labels_ocr_only' | 'not_analyzed';
}
export interface FigureStructure {
  type: 'figure';
  caption_region_id?: string | null;
  image_asset_id?: string | null;
  referenced_by_region_ids?: string[];
  /** H2: 'vector' = drawn with PDF path operators (boxes, arrows, bars), not a picture; absent = a picture */
  origin?: 'vector';
}
export type RegionStructure = TableStructure | DiagramStructure | FigureStructure;

export interface SourceRegionView {
  id: string;
  version_id: string;
  page_id: string | null;
  parent_region_id: string | null;
  kind: RegionKind;
  reading_order: number;
  bbox: NormBox | null;
  /** non-page locators: { paragraph_index, heading_path } | { slide, shape_id } | { start_ms, end_ms } | { file_name } */
  locator: Record<string, unknown> | null;
  text: string | null;
  text_origin: 'digital' | 'ocr' | 'owner' | 'vision' | null;
  lang: string | null;
  confidence: number | null;
  structure: RegionStructure | null;
  status: 'extracted' | 'checks_passed' | 'needs_review' | 'uncertain' | 'owner_reviewed' | 'rejected';
}

/**
 * H2 item 6: one OCR word of a region — its text as it appears in the region text and its box normalized to the
 * unrotated page box ([text, x, y, w, h]). Stored in `locator.words` of OCR regions, in reading order, so the reader can
 * place each word over the scanned glyphs (selection and search-hit rectangles on the right words).
 */
export type RegionWord = [text: string, x: number, y: number, w: number, h: number];

/** The OCR word boxes of a region (`locator.words`), validated; null when the region has none. */
export function regionWords(r: Pick<SourceRegionView, 'locator'>): RegionWord[] | null {
  const raw = r.locator?.words;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RegionWord[] = [];
  for (const w of raw) {
    if (!Array.isArray(w) || w.length !== 5 || typeof w[0] !== 'string' || !w[0]) return null;
    const [t, x, y, ww, h] = w as unknown[];
    if (![x, y, ww, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    out.push([t as string, x as number, y as number, ww as number, h as number]);
  }
  return out;
}

export interface PageRegionsResponse {
  page: SourcePageView;
  regions: SourceRegionView[];
}

export interface UploadFileResult {
  file_name: string;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason_ar?: string;
  detected_format?: SourceFormat | 'doc' | 'ppt' | 'zip' | 'unknown';
  size: number;
  source_id?: string;
  version_id?: string;
  /** set when identical content already exists (sha256 match). Nothing is deleted silently. */
  duplicate_of?: { source_id: string; version_id: string; title: string };
  /** entries of a ZIP that were skipped and why */
  rejected_entries?: Array<{ name: string; reason_ar: string }>;
  suggested_source_type?: SourceType;
}
export interface UploadResponse {
  results: UploadFileResult[];
}

/**
 * «ص 12» or «ص 12 (الصفحة 14 في الملف)» when the printed label differs from file order (AC-04). A page without a
 * printed number in a version whose other pages are numbered is «الصفحة 3 في الملف» (its only true identity).
 */
export function pageDisplayLabel(
  page: Pick<SourcePageView, 'page_index' | 'printed_label' | 'kind' | 'numbered_version'>,
  opts: { withFileIndex?: boolean } = {},
): string {
  const fileNo = page.page_index + 1;
  if (page.kind === 'slide') return `شريحة ${page.printed_label ?? fileNo}`;
  if (page.kind === 'image') return `صورة ${fileNo}`;
  if (page.kind === 'docx_section') return `قسم ${fileNo}`;
  if (page.printed_label && page.printed_label !== String(fileNo)) {
    return opts.withFileIndex === false ? `ص ${page.printed_label}` : `ص ${page.printed_label} (الصفحة ${fileNo} في الملف)`;
  }
  if (!page.printed_label && page.numbered_version) return `الصفحة ${fileNo} في الملف`;
  return `ص ${page.printed_label ?? fileNo}`;
}

/**
 * (H1) A version's page list with `numbered_version` filled on every page that lacks it (an answer cached before the
 * server sent the flag, or a list built on the client) — the same rule as the server: some page of kind «page»
 * carries a printed number. Pass the WHOLE page list of one version (a filtered list could miss the numbered pages).
 */
export function withNumberedVersion<P extends Pick<SourcePageView, 'kind' | 'printed_label'> & { numbered_version?: boolean }>(
  pages: readonly P[],
): Array<P & { numbered_version: boolean }> {
  const numbered = pages.some((p) => p.kind === 'page' && !!p.printed_label);
  return pages.map((p) => ({ ...p, numbered_version: typeof p.numbered_version === 'boolean' ? p.numbered_version : numbered }));
}

/** Job kind contract between sources (enqueues) and processing (handles). */
export const PROCESS_JOB_KIND = 'process_source_version';
export interface ProcessJobInput {
  version_id: string;
  /** when set, only these pages are (re)processed */
  page_indexes?: number[];
  reason?: 'upload' | 'reprocess' | 'replacement';
}
