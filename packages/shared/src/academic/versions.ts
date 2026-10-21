// Academic OS — lecture identity, page fingerprints, version page maps, compare and link candidates (track P1-T3).
// Sources of truth: ARCHITECTURE_DELTA §4.2 (migrations 0160, 0161), §6.1 (identities), §6.2 (page mapping between
// versions), §6.9 (linking a private lecture to an official one); BUILD_PLAN §3.5; PRD AOS-3.2…3.18, 19H.2, 21.13.
//
// STABLE CONTRACT for other tracks:
//  * P1-T2 step 3 (`reanchor_copy`) reads a page map through the server service
//    `getPageMap(ctx, fromVersionId, toVersionId)` in apps/server/src/modules/versions/pagemap.ts, which returns
//    `VersionPageMap` (below). A note on an old page may be COPIED to `entry.to_page_id` only when
//    `isCopyTarget(entry)`; ink and other coordinate-anchored items additionally need `entry.layout_safe` (or a
//    `confirmed` entry, which is a human decision). Everything else goes to «تحتاج مراجعة». The map never moves or
//    deletes anything itself.
//  * P1-T5 reuses `matchLinkCandidates()` (apps/server/src/modules/versions/candidates.ts, a pure function over the
//    `LinkCandidateInput` shapes below) to find an official twin of a private lecture.
// Fields are only ever ADDED to these types; nothing is renamed or removed.

// ───────────────────────────── lecture identity (0160) ─────────────────────────────
export const LECTURE_NO_ORIGINS = ['detected', 'owner', 'moderator'] as const;
export type LectureNoOrigin = (typeof LECTURE_NO_ORIGINS)[number];

export interface LectureIdentityView {
  source_id: string;
  title: string;
  /** the uploaded file name of the first version (kept even when the title is cleaned, AOS-3.3) */
  original_file_name: string | null;
  lecture_no: number | null;
  lecture_no_origin: LectureNoOrigin | null;
  /** YYYY-MM-DD, the lecture's session date */
  held_on: string | null;
  held_on_origin: LectureNoOrigin | null;
  /** a vault stub of an official lecture (P1-T5); always false in R1-a */
  is_stub: boolean;
}

export interface UpdateLectureIdentityRequest {
  /** null clears it; the value is then the owner's decision and automation never overrides it */
  lecture_no?: number | null;
  held_on?: string | null;
}

// ───────────────────────────── import suggestions (review queue of the uploader) ─────────────────────────────
export const IMPORT_SUGGESTION_FIELDS = ['lecture_no', 'held_on', 'title', 'subject', 'new_version_of'] as const;
export type ImportSuggestionField = (typeof IMPORT_SUGGESTION_FIELDS)[number];
export const IMPORT_SUGGESTION_FIELD_LABELS_AR: Record<ImportSuggestionField, string> = {
  lecture_no: 'رقم المحاضرة',
  held_on: 'تاريخ المحاضرة',
  title: 'اسم المحاضرة',
  subject: 'المادة',
  new_version_of: 'إصدار جديد من محاضرة موجودة',
};

/**
 * `certain` values of lecture_no / held_on are stored automatically with origin `detected` (status `applied`, the owner
 * can change them); `uncertain` ones stay `open` and have NO downstream effect until the owner accepts (AOS-3.18).
 * Titles, subjects and new-version proposals are always held for confirmation, whatever their certainty.
 */
export const IMPORT_SUGGESTION_STATUSES = ['open', 'applied', 'accepted', 'rejected', 'superseded'] as const;
export type ImportSuggestionStatus = (typeof IMPORT_SUGGESTION_STATUSES)[number];
export const IMPORT_SUGGESTION_STATUS_LABELS_AR: Record<ImportSuggestionStatus, string> = {
  open: 'بانتظار تأكيدك',
  applied: 'اكتُشف تلقائيًا',
  accepted: 'أكّدته',
  rejected: 'رفضته',
  superseded: 'حلّ محله اقتراح أحدث',
};
export type SuggestionCertainty = 'certain' | 'uncertain';

export type ImportSuggestionValue =
  | { field: 'lecture_no'; lecture_no: number }
  | { field: 'held_on'; held_on: string }
  | { field: 'title'; title: string }
  | { field: 'subject'; node_id: string; node_title: string; node_kind: string; path: string[] }
  | {
      field: 'new_version_of';
      source_id: string;
      version_id: string;
      title: string;
      /** pages of the EXISTING lecture that have a safe counterpart in the upload */
      matched_pages: number;
      total_pages: number;
      ratio: number;
      inserted: number;
      removed: number;
      changed: number;
    };

export interface ImportSuggestionView {
  id: string;
  source_id: string;
  source_title: string;
  version_id: string | null;
  field: ImportSuggestionField;
  value: ImportSuggestionValue;
  certainty: SuggestionCertainty;
  status: ImportSuggestionStatus;
  /** why it was suggested (matched tokens, where it was found) */
  reasons_ar: string[];
  /** what accepting does — stated before the owner decides */
  effect_ar: string;
  created_at: number;
  decided_at: number | null;
}

export interface ImportSuggestionListResponse {
  suggestions: ImportSuggestionView[];
}

export interface DecideSuggestionRequest {
  action: 'accept' | 'reject';
}

export interface DecideSuggestionResponse {
  suggestion: ImportSuggestionView;
  /** what was changed, in Arabic (e.g. «نُقل المصدر إلى …», «أُضيف كإصدار 2 من …») */
  result_ar: string;
  /** set when accepting a new-version proposal: the existing lecture and its new version */
  new_version?: { source_id: string; version_id: string; version_no: number; upload_trashed: boolean };
}

// ───────────────────────────── ordering (AOS-3.5) ─────────────────────────────
export const LECTURE_ORDER_MODES = ['number', 'date'] as const;
export type LectureOrderMode = (typeof LECTURE_ORDER_MODES)[number];
export const LECTURE_ORDER_MODE_LABELS_AR: Record<LectureOrderMode, string> = { number: 'حسب الرقم', date: 'حسب التاريخ' };

export interface LectureOrderItem {
  source_id: string;
  title: string;
  lecture_no: number | null;
  held_on: string | null;
  /** the folder's manual order (lower first) */
  sort_order: number;
  created_at: number;
}

const naturalTitle = (a: string, b: string) => a.localeCompare(b, ['ar', 'en'], { numeric: true, sensitivity: 'base' });

/**
 * Pure, stable ordering: «حسب الرقم» = lecture number, then date, then natural title; «حسب التاريخ» = date, then
 * number, then natural title. Items without the key go last (in natural-title order). Ties keep the manual order,
 * then creation time, then id — so the result never depends on the input order.
 */
export function orderLectures<T extends LectureOrderItem>(items: readonly T[], mode: LectureOrderMode): T[] {
  const cmpNum = (a: T, b: T) => (a.lecture_no === null ? (b.lecture_no === null ? 0 : 1) : b.lecture_no === null ? -1 : a.lecture_no - b.lecture_no);
  const cmpDate = (a: T, b: T) => (a.held_on === null ? (b.held_on === null ? 0 : 1) : b.held_on === null ? -1 : a.held_on < b.held_on ? -1 : a.held_on > b.held_on ? 1 : 0);
  const keys = mode === 'number' ? [cmpNum, cmpDate] : [cmpDate, cmpNum];
  return [...items].sort(
    (a, b) =>
      keys[0]!(a, b) ||
      keys[1]!(a, b) ||
      naturalTitle(a.title, b.title) ||
      a.sort_order - b.sort_order ||
      a.created_at - b.created_at ||
      (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0),
  );
}

export interface LectureOrderResponse {
  node_id: string;
  mode: LectureOrderMode;
  items: Array<LectureOrderItem & { position: number }>;
  /** lectures without the ordering key (they keep the end of the list) */
  missing_key: number;
  /** the folder's own ordering mode; a manual order is never replaced unless the owner applies this one */
  node_sort_mode: string;
}

export interface ApplyLectureOrderRequest {
  node_id: string;
  mode: LectureOrderMode;
}

// ───────────────────────────── page fingerprints and maps (0161) ─────────────────────────────
export const PAGE_MAP_STATUSES = ['safe', 'uncertain', 'none', 'confirmed', 'rejected'] as const;
export type PageMapStatus = (typeof PAGE_MAP_STATUSES)[number];
export const PAGE_MAP_METHODS = ['identical', 'text_similarity', 'image_similarity', 'moderator', 'owner'] as const;
export type PageMapMethod = (typeof PAGE_MAP_METHODS)[number];

/** What happened to a page between two versions (derived from the map; shown on the compare screen). */
export const PAGE_CHANGE_KINDS = ['unchanged', 'edited', 'changed', 'moved', 'inserted', 'removed'] as const;
export type PageChangeKind = (typeof PAGE_CHANGE_KINDS)[number];
export const PAGE_CHANGE_LABELS_AR: Record<PageChangeKind, string> = {
  unchanged: 'لم تتغير',
  edited: 'تعديل طفيف',
  changed: 'تغيّرت',
  moved: 'نُقلت من مكانها',
  inserted: 'صفحة جديدة',
  removed: 'حُذفت',
};

export interface PageMapEntry {
  from_page_id: string;
  from_page_index: number;
  /** null: no counterpart (removed, or rejected by the owner) */
  to_page_id: string | null;
  to_page_index: number | null;
  status: PageMapStatus;
  method: PageMapMethod;
  /** 1 → normalised coordinates may be reused on the new page (ink, shapes, boxes) */
  layout_safe: boolean;
  /** estimated Jaccard similarity of the page texts (MinHash), when both have text */
  text_score: number | null;
  /** Hamming distance of the page-image dHashes (0–64), when both were rendered */
  image_distance: number | null;
  change: PageChangeKind;
  /** a human decision (confirmed / rejected); automation never overrides it */
  decided_by: 'auto' | 'owner' | 'moderator';
}

export interface InsertedPage {
  to_page_id: string;
  to_page_index: number;
}

export interface VersionPageMap {
  from_version_id: string;
  to_version_id: string;
  /** fingerprint scheme + thresholds, e.g. «pm1:j0.85:d6:low0.3|fp1:…» */
  algo: string;
  computed_at: number;
  /** one entry per page of the FROM version, in its page order */
  entries: PageMapEntry[];
  /** pages of the TO version that no entry points at, in their page order */
  inserted: InsertedPage[];
  counts: Record<PageChangeKind, number>;
}

/** May an item of the old page be copied to `to_page_id` without asking? (layout still decides coordinates) */
export function isCopyTarget(e: Pick<PageMapEntry, 'status' | 'to_page_id'>): boolean {
  return e.to_page_id !== null && (e.status === 'safe' || e.status === 'confirmed');
}

export function emptyChangeCounts(): Record<PageChangeKind, number> {
  return { unchanged: 0, edited: 0, changed: 0, moved: 0, inserted: 0, removed: 0 };
}

// ───────────────────────────── compare API ─────────────────────────────
export interface CompareVersionRef {
  source_id: string;
  source_title: string;
  version_id: string;
  version_no: number;
  file_name: string | null;
  page_count: number | null;
}

export interface ComparePageRef {
  page_id: string;
  page_index: number;
  label_ar: string;
  /** first characters of the page text (null: the page has no text) */
  excerpt: string | null;
  /** a page image can be rendered (`GET /api/versions/pages/:pageId/thumbnail`) */
  thumbnail: boolean;
}

export interface CompareRow {
  key: string;
  change: PageChangeKind;
  from: ComparePageRef | null;
  to: ComparePageRef | null;
  status: PageMapStatus | null;
  method: PageMapMethod | null;
  layout_safe: boolean;
  text_score: number | null;
  image_distance: number | null;
  decided_by: 'auto' | 'owner' | 'moderator';
  /** word-level text difference for edited / changed / moved rows (bounded) */
  diff: { removed: string[]; added: string[] } | null;
}

export interface VersionCompareResponse {
  state: 'ready' | 'pending' | 'failed';
  reason_ar: string | null;
  from: CompareVersionRef;
  to: CompareVersionRef;
  algo: string | null;
  /** rows in reading order of the NEW version, with removed pages placed where they were */
  rows: CompareRow[];
  counts: Record<PageChangeKind, number>;
  job_id: string | null;
  /** an open «إصدار جديد من …» proposal between exactly these two versions */
  proposal: ImportSuggestionView | null;
}

export interface PageMapDecisionRequest {
  from_page_id: string;
  action: 'confirm' | 'reject' | 'reset';
  /** confirm: the new page that is the same page (default: the current counterpart) */
  to_page_id?: string;
}

// ───────────────────────────── link candidates (AOS-19H.2/19H.3, used by P1-T5) ─────────────────────────────
/** The fingerprint of one page as the pure matcher needs it. */
export interface PageFingerprintInput {
  page_id: string;
  page_index: number;
  text_norm_hash: string | null;
  /** 64 × u32 MinHash over word 3-shingles (null: too little text) */
  minhash: Uint32Array | null;
  /** 64-bit dHash, 16 hex digits (null: not rendered) */
  dhash: string | null;
  /** hash of the text-region geometry (null: no text regions) */
  layout_hash: string | null;
  text_len: number;
}

export interface LinkCandidateInput {
  source_id: string;
  version_id: string;
  title: string;
  /** sha256 of the version's file bytes */
  content_hash: string;
  pages: PageFingerprintInput[];
}

export interface LinkCandidateView {
  source_id: string;
  version_id: string;
  title: string;
  basis: 'sha256' | 'fingerprints';
  /** pages of the candidate with a safe counterpart in the target */
  matched_pages: number;
  total_pages: number;
  ratio: number;
  basis_ar: string[];
}

export interface LinkCandidatesResponse {
  source_id: string;
  candidates: LinkCandidateView[];
  /** the minimum share of matching pages (0.6) */
  threshold: number;
}

// ───────────────────────────── printed table of contents (AOS-3.9) ─────────────────────────────
export type TocResolution = 'printed_label' | 'title_match' | 'file_order' | 'unresolved';
export const TOC_RESOLUTION_LABELS_AR: Record<TocResolution, string> = {
  printed_label: 'برقم الصفحة المطبوع',
  title_match: 'بمطابقة العنوان',
  file_order: 'تقديري: بترتيب الصفحات في الملف',
  unresolved: 'لم تُعرف الصفحة',
};

export interface PrintedTocEntry {
  title: string;
  /** the page number as printed in the contents (Latin digits) */
  printed_page: string;
  toc_page_index: number;
  target: { page_id: string; page_index: number; label_ar: string } | null;
  resolution: TocResolution;
}

export interface PrintedTocView {
  version_id: string;
  toc_page_indexes: number[];
  entries: PrintedTocEntry[];
}

// ───────────────────────────── original vs converted files (AOS-2.4, 3.14) ─────────────────────────────
export type VersionFileRole = 'original' | 'rendered' | 'display_pdf' | 'docx_display_pdf';
export const VERSION_FILE_ROLE_LABELS_AR: Record<VersionFileRole, string> = {
  original: 'الملف الأصلي كما رُفع',
  rendered: 'الملف الذي تُقرأ منه الصفحات',
  display_pdf: 'نسخة عرض PDF (محوّلة)',
  docx_display_pdf: 'نسخة عرض PDF من مستند Word (محوّلة)',
};

export interface VersionFileView {
  role: VersionFileRole;
  file_id: string;
  file_name: string | null;
  mime: string;
  size: number;
}

export interface DocxRenditionView {
  status: 'ready' | 'failed' | 'unavailable' | 'pending';
  reason_ar: string | null;
  page_count: number | null;
  fonts: Array<{ name: string; embedded: boolean }>;
  engine: string | null;
  job_id: string | null;
}

export interface VersionFilesResponse {
  version_id: string;
  format: string;
  files: VersionFileView[];
  /** DOCX only: the display PDF made with LibreOffice (paragraph locators stay the evidence) */
  docx_rendition: DocxRenditionView | null;
}

// ───────────────────────────── one source's identity screen ─────────────────────────────
export interface SourceIdentityResponse {
  identity: LectureIdentityView;
  suggestions: ImportSuggestionView[];
  /** analysis of the current version: fingerprints, detection (null: not run yet) */
  analysis: { version_id: string; state: 'ready' | 'pending' | 'failed' | 'not_run'; job_id: string | null; reason_ar: string | null } | null;
}
