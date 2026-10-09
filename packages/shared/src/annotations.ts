// Ink / annotation / note / session contract (§25, §26, §27, §47, AC-21, AC-22, AC-24).
// Shared by the web ink engine (writes to IndexedDB + outbox), the server annotations module
// (sync handlers + read APIs) and anything that renders annotations.
import type { NormBox } from './geometry';
import type { RichText } from './richtext';

/** [x, y, t, pressure?, tiltX?, tiltY?] — x,y normalized to the UNROTATED page box; t = ms since stroke start. */
export type InkPoint = [number, number, number, number?, number?, number?];

export const INK_TOOLS = ['pen', 'fountain', 'ball', 'highlighter'] as const;
export type InkPenTool = (typeof INK_TOOLS)[number];

export interface InkStyle {
  tool: InkPenTool;
  /** color token or #rrggbb */
  color: string;
  /** base stroke width as a fraction of the page WIDTH (zoom independent), e.g. 0.0025 */
  width: number;
  opacity?: number;
}

export interface InkData {
  v: 1;
  points: InkPoint[];
  style: InkStyle;
  bbox: NormBox;
  /** what the input device actually reported (never assume) */
  pressure_available: boolean;
  tilt_available: boolean;
}

export interface ShapeData {
  v: 1;
  shape: 'line' | 'arrow' | 'rect' | 'ellipse';
  /** normalized corners / endpoints */
  from: [number, number];
  to: [number, number];
  rotation?: number;
  style: InkStyle;
  /** when produced by shape recognition, the original stroke is kept so the owner can reject the enhancement */
  recognized_from?: InkData;
}

export interface TextBoxData {
  v: 1;
  box: NormBox;
  text: RichText;
  color: string;
  font_scale: number;
}

export interface StickyData {
  v: 1;
  at: [number, number];
  text: string;
  color: string;
  collapsed?: boolean;
}

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface TextHighlightData {
  v: 1;
  style: 'highlight' | 'underline';
  color: string;
  /** visual rects on the page (normalized) */
  rects: NormBox[];
  quote: TextQuote;
  /** region ids the selection intersects, when known */
  region_ids?: string[];
}

export interface BookmarkData {
  v: 1;
  label?: string;
}

export type AnnotationKind = 'ink' | 'highlight' | 'underline' | 'shape' | 'text' | 'sticky' | 'image' | 'bookmark' | 'link' | 'text_highlight';

export type AnnotationAnchor =
  | { type: 'page'; source_id: string; version_id: string; page_id: string; page_index: number; space: 'page_norm' }
  | { type: 'note_page'; note_page_id: string; space: 'page_norm' }
  | { type: 'block'; lineage_id: string; artifact_version: number; block_key: string; quote?: TextQuote; start?: number; end?: number };

export function annotationTargetKey(anchor: AnnotationAnchor): string {
  switch (anchor.type) {
    case 'page':
      return `source_page:${anchor.page_id}`;
    case 'note_page':
      return `note_page:${anchor.note_page_id}`;
    case 'block':
      return `artifact_block:${anchor.lineage_id}:${anchor.block_key}`;
  }
}

/** Wire format of an annotation (sync payload for upsert/append, pull entity, read APIs). snake_case. */
export interface AnnotationDTO {
  id: string;
  kind: AnnotationKind;
  tool: string | null;
  anchor: AnnotationAnchor;
  data: InkData | ShapeData | TextBoxData | StickyData | TextHighlightData | BookmarkData | Record<string, unknown>;
  layer: 'ink' | 'highlight' | 'text' | 'media';
  z: number;
  locked: boolean;
  anchor_status: 'ok' | 'needs_reanchor' | 'reanchored';
  previous_anchor: AnnotationAnchor | null;
  /** pointerType, pressure/tilt availability, device label — for the capability matrix, never PII */
  input: { pointer_type?: string; pressure?: boolean; tilt?: boolean } | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface NoteDTO {
  id: string;
  node_id: string | null;
  title: string | null;
  body: RichText;
  anchor: AnnotationAnchor | null;
  origin: 'owner' | 'ai_answer' | 'handwriting_recognition';
  ai_record: Record<string, unknown> | null;
  rev: number;
  conflict_of_id: string | null;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface NotePageDTO {
  id: string;
  node_id: string | null;
  source_id: string | null;
  after_page_index: number | null;
  title: string | null;
  template: 'blank' | 'ruled' | 'dotted' | 'grid';
  width: number;
  height: number;
  sort_order: number;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Where the owner was (§46 Study Session). */
export interface StudyLocation {
  page_index?: number;
  page_id?: string;
  block_key?: string;
  zoom?: number;
  /** scroll offset inside the page as a fraction [0,1] */
  page_offset?: number;
  rotation?: number;
  layout?: 'single' | 'double' | 'continuous';
  rail?: { open: boolean; width: number; tab: string };
  left_panel?: { open: boolean; tab: 'thumbnails' | 'outline' | 'bookmarks' };
  split?: { mode: string; secondary_source_id?: string; secondary_page_index?: number } | null;
}

export interface StudySessionDTO {
  id: string;
  source_id: string | null;
  version_id: string | null;
  mode: 'learn' | 'understand' | 'practice' | 'review' | 'exam';
  view: 'original' | 'study_book' | 'split';
  location: StudyLocation;
  scope: unknown | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
}

/** Entity types synced through /api/sync for this contract. */
export const ANNOTATION_SYNC_ENTITIES = ['annotation', 'note', 'note_page', 'study_session'] as const;
