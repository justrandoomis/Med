// Annotations / sessions / reading-progress read API (/api/annotations) — §25, §26, §45, §46, §47.
// Written by the annotations server module (track B1) and consumed by the workspace reader,
// the ink engine and the home screen (Continue Studying). Sync payloads use the DTOs from
// ./annotations (AnnotationDTO, NoteDTO, NotePageDTO, StudySessionDTO).
import type { AnnotationDTO, NoteDTO, NotePageDTO, NotePageView, StudySessionDTO } from './annotations';
import type { SourceType } from './enums';

/** GET /api/annotations/by-targets?keys=source_page:<id>,note_page:<id>,… (live annotations only). */
export interface AnnotationsByTargetsResponse {
  annotations: AnnotationDTO[];
}

/** GET /api/annotations/source/:sourceId?version_id= — everything the owner wrote on a document (offline download). */
export interface SourceAnnotationsResponse {
  source_id: string;
  /** the versions whose pages were included */
  version_ids: string[];
  annotations: AnnotationDTO[];
  notes: NoteDTO[];
  note_pages: NotePageDTO[];
}

/** GET /api/annotations/notes?source_id=&node_id=&page_id= */
export interface NotesResponse {
  notes: NoteDTO[];
}

/** One annotation whose anchor could not be kept with confidence (§25: never deleted, never moved silently). */
export interface NeedsReanchorItem {
  annotation: AnnotationDTO;
  source_id: string | null;
  source_title: string | null;
  /** Arabic description of where it used to be, e.g. «ص 12 (الصفحة 14 في الملف) — الإصدار 1» */
  previous_location_ar: string | null;
}
export interface NeedsReanchorResponse {
  items: NeedsReanchorItem[];
  /**
   * (H3 item 2) notes whose place is gone: a page anchor whose page no longer exists in its version, or a Study Book
   * paragraph the re-anchoring report lists as `needs_reanchor` (AC-22)
   */
  notes?: NeedsReanchorNoteItem[];
  /** (H3 item 2) items the owner chose to keep detached («محفوظة دون ربط») — still listed, can be re-anchored */
  detached?: { annotations: NeedsReanchorItem[]; notes: NeedsReanchorNoteItem[] };
}

/** (H3 item 2) A note that needs the owner to choose a new place. */
export interface NeedsReanchorNoteItem {
  note: NoteDTO;
  source_id: string | null;
  source_title: string | null;
  previous_location_ar: string | null;
  /** why it is listed («صفحتها لم تعد موجودة في هذا الإصدار» …) */
  reason_ar: string;
}

/**
 * (H3 item 2) Where the owner re-anchors an item: a page of the source (optionally ON a paragraph / block region of
 * that page — the item group is placed at the region; without a region the group keeps its place on the page), or a
 * paragraph of the Study Book (notes).
 */
export type ReanchorTarget =
  | { type: 'page'; version_id: string; page_id: string; region_id?: string | null }
  | { type: 'block'; lineage_id: string; artifact_version: number; block_key: string };

/** POST /api/annotations/reanchor — one owner decision for a note / highlight / ink group (audited). */
export interface ReanchorRequest {
  /** the group, with the revision this device saw (a newer edit elsewhere → 409, nothing changes) */
  items: Array<{ kind: 'annotation' | 'note'; id: string; rev: number }>;
  action: 'move' | 'keep_detached';
  target?: ReanchorTarget;
}

export interface ReanchorResponse {
  annotations: AnnotationDTO[];
  notes: NoteDTO[];
  summary_ar: string;
}

/** GET /api/annotations/sessions/latest?source_id= */
export interface LatestSessionResponse {
  session: StudySessionDTO | null;
}

/**
 * Reading progress ONLY (§45): which pages of one version were shown on screen. It is never
 * completion, explanation coverage, practice or mastery — the UI must say «صفحات عُرضت».
 */
export interface ReadingProgressView {
  source_id: string;
  /** version the viewed pages belong to (pages of another version are not counted) */
  version_id: string | null;
  /** 0-based page indexes that were shown */
  pages_viewed: number[];
  /** page count of that version (null when unknown) */
  pages_total: number | null;
  /** pages_viewed.length / pages_total (0 when the total is unknown) */
  reading_progress: number;
  updated_at: number | null;
}

/** POST /api/annotations/progress */
export interface ReadingProgressRequest {
  source_id: string;
  version_id: string;
  page_index?: number;
  page_indexes?: number[];
}

/** GET /api/annotations/sessions/recent?limit= — Continue Studying (§45): one entry per source, newest first. */
export interface ContinueStudyingItem {
  session: StudySessionDTO;
  source: { id: string; title: string; source_type: SourceType; archived: boolean };
  version: { id: string; version_no: number; is_active: boolean } | null;
  /** the page the owner was on, when it still exists */
  page: { id: string; page_index: number; printed_label: string | null; kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment'; label_ar: string } | null;
  reading: ReadingProgressView | null;
}
export interface RecentSessionsResponse {
  items: ContinueStudyingItem[];
}

// ───────── Notebook pages, images (track F1) ─────────

/** GET /api/annotations/note-pages?node_id=|source_id=[&include_deleted=1] — sorted by sort_order, created_at. */
export interface NotePagesResponse {
  note_pages: NotePageView[];
}

/** GET /api/annotations/notebook/:nodeId — a notebook's live pages and everything written on them (seeding / offline). */
export interface NotebookContentResponse {
  node_id: string;
  note_pages: NotePageView[];
  annotations: AnnotationDTO[];
}

/**
 * (Round 7 — H3) GET /api/annotations/orphan-pages[?include_deleted=1] — «صفحات بلا دفتر»: note pages that belong to
 * neither a notebook / folder nor a source (their notebook or source was purged while a device that still wrote on
 * them was offline). Kept, never deleted by the server; listed with the writing on the live ones so the owner can move
 * them into a notebook or trash them. Trashed orphans only with include_deleted (the restore list).
 */
export interface OrphanNotePagesResponse {
  note_pages: NotePageView[];
  annotations: AnnotationDTO[];
}

/** One uploaded picture of an image annotation (POST /api/annotations/images, GET …/images/:key/meta). */
export interface AnnotationImageView {
  image_key: string;
  file_id: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** live annotations that show it */
  used_by: number;
  created_at: number;
}
export interface AnnotationImageUploadResponse {
  image: AnnotationImageView;
  /** the same key was uploaded before (idempotent retry) */
  duplicate: boolean;
}
