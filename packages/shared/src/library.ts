// Library & Sources API — request/response shapes not covered by sources.ts (tags, topics, templates,
// cover tokens, request bodies). Implemented by apps/server/src/modules/{library,sources} and consumed by
// apps/web/src/features/{library,upload,sources}.
import type { JobView } from './api';
import type { LibraryNodeKind, LectureKind, SourceType } from './enums';
import type { LibraryNodeView, NodeCover, ProcessingSummary, SourceLinkView, SourceSummary, TagView } from './sources';

/** Cover colour TOKENS (never raw hex). The web maps each to light/dark values. */
export const COVER_COLORS = ['indigo', 'teal', 'rose', 'amber', 'slate', 'green', 'plum', 'sky'] as const;
export type CoverColor = (typeof COVER_COLORS)[number];
export const COVER_COLOR_LABELS_AR: Record<CoverColor, string> = {
  indigo: 'نيلي',
  teal: 'أخضر مزرق',
  rose: 'وردي',
  amber: 'كهرماني',
  slate: 'رمادي أزرق',
  green: 'أخضر',
  plum: 'برقوقي',
  sky: 'سماوي',
};
export const COVER_STYLES = ['plain', 'linen', 'grid', 'dots'] as const satisfies ReadonlyArray<NodeCover['style']>;
export const COVER_STYLE_LABELS_AR: Record<NodeCover['style'], string> = {
  plain: 'سادة',
  linen: 'كتّان',
  grid: 'مربعات',
  dots: 'نقاط',
};

/** Icon TOKENS for notebooks/folders (the web maps them to icons). */
export const LIBRARY_ICONS = [
  'book', 'stethoscope', 'heart', 'brain', 'bone', 'pill', 'microscope', 'baby', 'scan', 'flask', 'syringe', 'activity', 'eye', 'folder',
] as const;
export type LibraryIcon = (typeof LIBRARY_ICONS)[number];

export const LIBRARY_NODE_KIND_LABELS_AR: Record<LibraryNodeKind, string> = {
  notebook: 'دفتر',
  folder: 'مجلد',
  subject: 'مادة',
  course: 'كورس',
  section: 'قسم',
  topic_folder: 'موضوع',
};

export const SORT_MODES = ['manual', 'title', 'updated', 'created'] as const;
export type SortMode = (typeof SORT_MODES)[number];
export const SORT_MODE_LABELS_AR: Record<SortMode, string> = {
  manual: 'ترتيبي اليدوي',
  title: 'حسب الاسم',
  updated: 'آخر تعديل',
  created: 'تاريخ الإضافة',
};

export const LECTURE_KIND_LABELS_AR: Record<LectureKind, string> = {
  theoretical: 'نظري',
  practical: 'عملي',
  clinical: 'سريري',
  mixed: 'مختلط',
};

// ───────── /api/library ─────────
export interface CreateNodeRequest {
  parent_id: string | null;
  kind: LibraryNodeKind;
  title: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  cover?: NodeCover | null;
  template?: string | null;
  sort_mode?: SortMode;
  is_favorite?: boolean;
}
export type PatchNodeRequest = Partial<Omit<CreateNodeRequest, 'parent_id'>>;

export interface MoveRequest {
  parent_id: string | null;
  /** place directly before this sibling … */
  before_id?: string;
  /** … or directly after it (omit both → append at the end) */
  after_id?: string;
}

export interface NodeResponse {
  node: LibraryNodeView;
}

export interface RestoreRequest {
  /** where to restore when the original parent is still in the trash (null = library root) */
  parent_id?: string | null;
}

export interface TagsResponse {
  tags: Array<TagView & { usage: number }>;
}
export interface TagLinkRequest {
  entity_type: 'library_node' | 'source';
  entity_id: string;
}

export interface TopicView {
  id: string;
  title: string;
  title_ar: string | null;
  parent_topic_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface TopicLinkView {
  id: string;
  topic_id: string;
  topic_title: string;
  topic_title_ar: string | null;
  entity_type: string;
  entity_id: string;
  origin: 'auto' | 'owner';
  status: 'suggested' | 'accepted' | 'rejected';
  created_at: number;
}
export interface TopicsResponse {
  topics: TopicView[];
}
export interface TopicLinksResponse {
  links: TopicLinkView[];
}

export interface StudyTemplateFolder {
  title: string;
  kind: LibraryNodeKind;
  children?: StudyTemplateFolder[];
}
export interface StudyTemplate {
  key: string;
  title_ar: string;
  /** English subject name (shown isolated LTR) */
  title_en: string;
  description_ar: string;
  /** explanation-template key used by the explanation rules engine (§19) */
  explanation_template: string;
  cover: NodeCover;
  icon: string;
  /** suggested skeleton created under the new subject; the owner can rename/move/delete freely */
  skeleton: StudyTemplateFolder[];
}
export interface TemplatesResponse {
  templates: StudyTemplate[];
}
export interface FromTemplateRequest {
  template_key: string;
  parent_id: string | null;
  title?: string;
}
export interface FromTemplateResponse {
  node: LibraryNodeView;
  created: number;
}

/** Links among the sources inside a node's subtree (course view: lecture ↔ references ↔ question sources). */
export interface NodeLinksResponse {
  links: Array<{ id: string; from_source_id: string; to_source_id: string; relation: SourceLinkView['relation'] }>;
}

export interface RecentResponse {
  sources: SourceSummary[];
}
export interface FavoritesResponse {
  nodes: LibraryNodeView[];
  sources: SourceSummary[];
}

// ───────── /api/sources ─────────
export interface PatchSourceRequest {
  title?: string;
  source_type?: SourceType;
  node_id?: string;
  language?: 'ar' | 'en' | 'mixed' | null;
  edition?: string | null;
  authors?: string[] | null;
  publication_date?: string | null;
  original_url?: string | null;
  lecture_kind?: LectureKind | null;
  priority?: number;
  selection_reason?: string | null;
  metadata_status?: 'unknown' | 'partial' | 'owner_confirmed';
  is_favorite?: boolean;
}

/** SourceSummary + who chose the type ('auto' = upload suggestion not yet confirmed by the owner). */
export interface SourceTypeOrigin {
  source_type_origin: 'auto' | 'owner';
}

export interface FreezeRequest {
  /** null → unfreeze (study tools follow the latest version) */
  version_id: string | null;
}

export interface CreateLinkRequest {
  to_source_id: string;
  relation: SourceLinkView['relation'];
}

export const SOURCE_LINK_LABELS_AR: Record<SourceLinkView['relation'], string> = {
  reference_for: 'مرجع لـ',
  question_source_for: 'مصدر أسئلة لـ',
  audio_for: 'تسجيل صوتي لـ',
  same_topic: 'الموضوع نفسه',
};

export interface ReprocessRequest {
  page_indexes?: number[];
}
export interface ReprocessResponse {
  job: JobView;
}

/** What the server accepts right now (shown on the upload screen; never guessed by the client). */
export interface UploadInfoResponse {
  max_upload_bytes: number;
  max_zip_entries: number;
  /** .doc/.ppt can be converted (LibreOffice present) */
  legacy_office: boolean;
  /** a document processing handler is registered (otherwise uploads are stored but not processed yet) */
  processing_available: boolean;
}

export interface ProcessingStatusResponse {
  summary: ProcessingSummary | null;
  job: JobView | null;
}
