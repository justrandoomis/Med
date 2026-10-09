// Annotations / sessions / reading-progress read API (/api/annotations) — §25, §26, §45, §46, §47.
// Written by the annotations server module (track B1) and consumed by the workspace reader,
// the ink engine and the home screen (Continue Studying). Sync payloads use the DTOs from
// ./annotations (AnnotationDTO, NoteDTO, NotePageDTO, StudySessionDTO).
import type { AnnotationDTO, NoteDTO, NotePageDTO, StudySessionDTO } from './annotations';
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
