// Row ↔ DTO mapping and small queries for the annotations module's tables
// (annotation, annotation_target, note, note_page, study_session, source_progress).
import {
  annotationTargetKey,
  normalizeForSearch,
  pageDisplayLabel,
  richTextToPlain,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NoteDTO,
  type NotePageDTO,
  type RichText,
  type StudyLocation,
  type StudySessionDTO,
} from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';

// ───────── rows ─────────
export interface AnnotationRow {
  id: string;
  kind: AnnotationDTO['kind'];
  tool: string | null;
  anchor_json: string;
  data_json: string;
  layer: AnnotationDTO['layer'];
  z: number;
  locked: number;
  anchor_status: AnnotationDTO['anchor_status'];
  previous_anchor_json: string | null;
  input_json: string | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  conflict_of_id: string | null;
}

export interface NoteRow {
  id: string;
  node_id: string | null;
  title: string | null;
  body_json: string;
  anchor_json: string | null;
  origin: NoteDTO['origin'];
  ai_record_json: string | null;
  rev: number;
  base_rev: number | null;
  conflict_of_id: string | null;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  source_id: string | null;
  anchor_target_key: string | null;
}

export interface NotePageRow {
  id: string;
  node_id: string | null;
  source_id: string | null;
  after_page_index: number | null;
  title: string | null;
  template: NotePageDTO['template'];
  width: number;
  height: number;
  sort_order: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  rev: number;
  device_id: string | null;
}

export interface StudySessionRow {
  id: string;
  source_id: string | null;
  version_id: string | null;
  mode: StudySessionDTO['mode'];
  view: StudySessionDTO['view'];
  location_json: string;
  scope_json: string | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
}

// ───────── DTOs ─────────
/** parse a NOT NULL json column written by this module */
const j = <T>(text: string | null): T => fromJson<T>(text) as T;

export function toAnnotationDTO(r: AnnotationRow): AnnotationDTO {
  return {
    id: r.id,
    kind: r.kind,
    tool: r.tool,
    anchor: j<AnnotationAnchor>(r.anchor_json),
    data: j<AnnotationDTO['data']>(r.data_json),
    layer: r.layer,
    z: r.z,
    locked: r.locked === 1,
    anchor_status: r.anchor_status,
    previous_anchor: r.previous_anchor_json ? j<AnnotationAnchor>(r.previous_anchor_json) : null,
    input: r.input_json ? fromJson<AnnotationDTO['input']>(r.input_json) : null,
    device_id: r.device_id,
    rev: r.rev,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

export function toNoteDTO(r: NoteRow): NoteDTO {
  return {
    id: r.id,
    node_id: r.node_id,
    title: r.title,
    body: j<RichText>(r.body_json),
    anchor: r.anchor_json ? j<AnnotationAnchor>(r.anchor_json) : null,
    origin: r.origin,
    ai_record: r.ai_record_json ? fromJson<Record<string, unknown>>(r.ai_record_json) : null,
    rev: r.rev,
    conflict_of_id: r.conflict_of_id,
    device_id: r.device_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

export function toNotePageDTO(r: NotePageRow): NotePageDTO {
  return {
    id: r.id,
    node_id: r.node_id,
    source_id: r.source_id,
    after_page_index: r.after_page_index,
    title: r.title,
    template: r.template,
    width: r.width,
    height: r.height,
    sort_order: r.sort_order,
    rev: r.rev,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

export function toSessionDTO(r: StudySessionRow): StudySessionDTO {
  return {
    id: r.id,
    source_id: r.source_id,
    version_id: r.version_id,
    mode: r.mode,
    view: r.view,
    location: j<StudyLocation>(r.location_json) ?? {},
    scope: r.scope_json ? fromJson<unknown>(r.scope_json) : null,
    device_id: r.device_id,
    rev: r.rev,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ───────── lookups ─────────
export const getAnnotation = (db: Db, id: string) => db.get<AnnotationRow>('SELECT * FROM annotation WHERE id = ?', [id]);
export const getNote = (db: Db, id: string) => db.get<NoteRow>('SELECT * FROM note WHERE id = ?', [id]);
export const getNotePage = (db: Db, id: string) => db.get<NotePageRow>('SELECT * FROM note_page WHERE id = ?', [id]);
export const getSession = (db: Db, id: string) => db.get<StudySessionRow>('SELECT * FROM study_session WHERE id = ?', [id]);

/** `source_page:<id>` → { target_type, target_id } for annotation_target. */
export function splitTargetKey(key: string): { target_type: 'source_page' | 'note_page' | 'artifact_block'; target_id: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const type = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!id || id.length > 300) return null;
  if (type !== 'source_page' && type !== 'note_page' && type !== 'artifact_block') return null;
  return { target_type: type, target_id: id };
}

export function writeAnnotationTarget(db: Db, annotationId: string, anchor: AnnotationAnchor): void {
  const t = splitTargetKey(annotationTargetKey(anchor))!;
  db.run(
    `INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, ?, ?)
     ON CONFLICT(annotation_id) DO UPDATE SET target_type = excluded.target_type, target_id = excluded.target_id`,
    [annotationId, t.target_type, t.target_id],
  );
}

/** Does a page anchor point at an existing page of that version (and source)? */
export function pageAnchorResolves(db: Db, anchor: AnnotationAnchor): boolean {
  if (anchor.type !== 'page') return true;
  const row = db.get<{ source_id: string }>(
    `SELECT v.source_id FROM source_page p JOIN source_version v ON v.id = p.version_id WHERE p.id = ? AND p.version_id = ?`,
    [anchor.page_id, anchor.version_id],
  );
  return !!row && row.source_id === anchor.source_id;
}

/** Note text for universal search (owner_content_fts holds the normalized search key only). */
export function indexNote(db: Db, note: { id: string; title: string | null; body: RichText; origin: string; deleted: boolean }): void {
  db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'note' AND entity_id = ?`, [note.id]);
  if (note.deleted) return;
  const text = normalizeForSearch([note.title ?? '', richTextToPlain(note.body)].filter(Boolean).join('\n'));
  if (!text.trim()) return;
  db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('note', ?, ?, ?)`, [note.id, note.origin, text]);
}

// ───────── pages & labels ─────────
export interface PageInfoRow {
  id: string;
  version_id: string;
  page_index: number;
  printed_label: string | null;
  kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment';
}

export function pageLabelAr(p: Pick<PageInfoRow, 'page_index' | 'printed_label' | 'kind'>): string {
  return pageDisplayLabel(p);
}

/** Arabic description of an anchor's location (for «تحتاج إعادة ربط»). */
export function describeAnchorAr(db: Db, anchor: AnnotationAnchor | null): { text: string | null; sourceId: string | null; sourceTitle: string | null } {
  if (!anchor) return { text: null, sourceId: null, sourceTitle: null };
  if (anchor.type === 'page') {
    const src = db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [anchor.source_id]);
    const page = db.get<PageInfoRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE id = ?', [anchor.page_id]);
    const ver = db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [anchor.version_id]);
    const where = page ? pageLabelAr(page) : `الصفحة ${anchor.page_index + 1} في الملف`;
    const text = ver ? `${where} — الإصدار ${ver.version_no}` : where;
    return { text, sourceId: anchor.source_id, sourceTitle: src?.title ?? null };
  }
  if (anchor.type === 'note_page') {
    const np = db.get<{ title: string | null; source_id: string | null }>('SELECT title, source_id FROM note_page WHERE id = ?', [anchor.note_page_id]);
    const src = np?.source_id ? db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [np.source_id]) : undefined;
    return { text: np?.title ? `صفحة ملاحظات: ${np.title}` : 'صفحة ملاحظات', sourceId: np?.source_id ?? null, sourceTitle: src?.title ?? null };
  }
  const quote = anchor.quote?.exact ? `«${anchor.quote.exact.slice(0, 80)}»` : null;
  return { text: quote ? `مقطع في كتاب الدراسة: ${quote}` : 'مقطع في كتاب الدراسة', sourceId: null, sourceTitle: null };
}

export { toJson };
