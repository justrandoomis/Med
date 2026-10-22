// Official lectures — rows, the request's space context, authz resources, the subject updates feed and the views
// (P1-T5 step 1; ARCHITECTURE_DELTA §4.4, §7.4). Every function here runs inside the SPACE binding of the request (or
// of a job), so `ctx.db` is the subject's space database; nothing here ever opens a vault.
import { createHash } from 'node:crypto';
import type {
  OfficialLectureDetail,
  OfficialLectureStatus,
  OfficialLectureView,
  OfficialVersionView,
  OfficialVersionUploader,
  SubjectEventKind,
  UserRef,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { lecturePowers, type LecturePowers, type OfficialLectureResource } from '../authz/rules/lectures';

export interface LectureRow {
  id: string;
  subject_node_id: string;
  source_id: string;
  title: string;
  lecture_no: number | null;
  lecture_no_origin: 'detected' | 'moderator' | null;
  held_on: string | null;
  status: OfficialLectureStatus;
  head_version_id: string | null;
  uploaded_by: string;
  approved_by: string | null;
  approved_at: number | null;
  withdrawn_reason: 'replaced' | 'error' | 'rights_takedown' | 'other' | null;
  withdrawn_note: string | null;
  withdrawn_by: string | null;
  takedown_at: number | null;
  client_body_hash: string | null;
  created_at: number;
  updated_at: number;
  withdrawn_at: number | null;
}

export interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  kind: string;
  file_id: string | null;
  original_file_id: string | null;
  display_file_id: string | null;
  content_hash: string;
  format: string;
  file_name: string | null;
  page_count: number | null;
  processing_status: string;
  created_at: number;
}

export interface PublishRow {
  version_id: string;
  lecture_id: string;
  published_by: string;
  published_at: number;
  change_note: string | null;
  previous_version_id: string | null;
  kind: 'upload' | 'correction';
  page_map_status: 'pending' | 'ready' | 'failed';
}

/** The space, subject and viewer of the current request (the binding hook bound the space for this route). */
export interface SpaceScope {
  spaceId: string;
  subjectNodeId: string;
  viewer: Viewer;
  powers: LecturePowers;
}

export const NOT_FOUND_AR = 'العنصر غير موجود.';
export const notFound = () => new AppError('NOT_FOUND', NOT_FOUND_AR, 404);

export function scopeOf(ctx: AppContext): SpaceScope {
  const b = ctx.binding.current();
  if (!b || b.kind !== 'space' || !b.viewer) throw new AppError('NOT_FOUND', 'المسار المطلوب غير موجود.', 404);
  return { spaceId: b.spaceId, subjectNodeId: b.subjectNodeId, viewer: b.viewer, powers: lecturePowers(b.viewer, b.spaceId, { memberships: ctx.authz.memberships }) };
}

/** Deterministic ids for rows a job may create twice (a retry never duplicates). */
export function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 26)}`;
}

export function lectureResource(scope: Pick<SpaceScope, 'spaceId'>, row: Pick<LectureRow, 'id' | 'status' | 'subject_node_id' | 'uploaded_by' | 'head_version_id'>): OfficialLectureResource {
  // a lecture has a head version once a version of it was published (withdrawal keeps it): a withdrawn lecture without
  // one was never published and stays a draft for visibility (review R1)
  return { type: 'official_lecture', spaceId: scope.spaceId, id: row.id, status: row.status, subjectNodeId: row.subject_node_id, uploadedBy: row.uploaded_by, everPublished: row.head_version_id !== null };
}

export function getLecture(ctx: AppContext, id: string): LectureRow | null {
  return ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE id = ?', [id]) ?? null;
}

/** The lecture, if the viewer may SEE it (404 with the body of a missing id otherwise — existence never leaks). */
export function visibleLecture(ctx: AppContext, scope: SpaceScope, id: string): LectureRow {
  const row = getLecture(ctx, id);
  if (!row) throw notFound();
  ctx.authz.assert(scope.viewer, 'view', lectureResource(scope, row));
  return row;
}

/**
 * May this viewer see a DRAFT (unpublished) version of the lecture? The subject's official moderators, the contributor
 * who uploaded THAT version, and — while the lecture itself is still the contributor's unpublished draft — its uploader
 * (a moderator's replacement file in their own draft). Another contributor's upload of a lecture waits for a moderator
 * and is nobody else's to see (review P1-T5 step 1, R2: it used to follow the lecture's uploader, not the version's).
 */
export function seesDraftVersion(scope: SpaceScope, row: Pick<LectureRow, 'uploaded_by' | 'status' | 'head_version_id'>, versionUploader: string | null): boolean {
  if (scope.powers.officialModerator) return true;
  if (!scope.powers.contributor) return false;
  if (versionUploader !== null && versionUploader === scope.viewer.userId) return true;
  const ownUnpublishedDraft = row.head_version_id === null && row.uploaded_by === scope.viewer.userId;
  return ownUnpublishedDraft;
}

/** The contributor or moderator who uploaded a version (null for a version without an upload row). */
export function versionUploader(ctx: AppContext, versionId: string): string | null {
  return ctx.db.get<{ u: string }>('SELECT uploaded_by AS u FROM official_version_upload WHERE version_id = ?', [versionId])?.u ?? null;
}

/** May the viewer see this version of the lecture (published ones for every viewer of the lecture, drafts per above)? */
export function versionVisibleTo(ctx: AppContext, scope: SpaceScope, row: Pick<LectureRow, 'uploaded_by' | 'status' | 'head_version_id'>, versionId: string): boolean {
  return !!publishOf(ctx, versionId) || seesDraftVersion(scope, row, versionUploader(ctx, versionId));
}

export function versionOf(ctx: AppContext, versionId: string): VersionRow | null {
  return (
    ctx.db.get<VersionRow>(
      `SELECT id, source_id, version_no, kind, file_id, original_file_id, display_file_id, content_hash, format, file_name, page_count, processing_status, created_at
       FROM source_version WHERE id = ?`,
      [versionId],
    ) ?? null
  );
}

export function publishOf(ctx: AppContext, versionId: string): PublishRow | null {
  return ctx.db.get<PublishRow>('SELECT * FROM official_version_publish WHERE version_id = ?', [versionId]) ?? null;
}

/** A version of THIS lecture the viewer may see (published ones for everybody, drafts for moderators / uploader). */
export function visibleVersion(ctx: AppContext, scope: SpaceScope, lecture: LectureRow, versionId: string): VersionRow {
  const v = versionOf(ctx, versionId);
  if (!v || v.source_id !== lecture.source_id) throw notFound();
  if (!versionVisibleTo(ctx, scope, lecture, v.id)) throw notFound();
  return v;
}

/** Append one entry of the subject updates feed (AOS-2.9) — call it INSIDE the transaction of the change it reports. */
export function appendSubjectEvent(
  ctx: AppContext,
  e: { subjectNodeId: string; kind: SubjectEventKind; refType: string; refId: string; title: string; moderatorsOnly?: boolean },
): void {
  ctx.db.run(`INSERT INTO subject_event (subject_node_id, kind, ref_type, ref_id, title, visibility_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    e.subjectNodeId,
    e.kind,
    e.refType,
    e.refId,
    e.title.slice(0, 300),
    e.moderatorsOnly ? 'mod' : null,
    ctx.clock.now(),
  ]);
}

// ───────────────────────────── views ─────────────────────────────

export class ViewBuilder {
  private readonly dir;
  private readonly refs = new Map<string, UserRef>();
  private subjectTitle: string | null | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly scope: SpaceScope,
  ) {
    this.dir = publicDirectory(ctx.system);
  }

  /** Load display names for these user ids in one query (names are read at request time, PRD Q14). */
  preload(ids: Array<string | null | undefined>): void {
    const missing = ids.filter((x): x is string => !!x && !this.refs.has(x));
    if (missing.length) for (const [id, ref] of this.dir.userRefs(this.scope.viewer, missing)) this.refs.set(id, ref);
  }

  user(id: string): UserRef {
    if (!this.refs.has(id)) this.preload([id]);
    return this.refs.get(id)!;
  }

  subject(subjectNodeId: string): { id: string; kind: 'subject'; title: string } {
    if (this.subjectTitle === undefined) this.subjectTitle = this.dir.spaceTitle(this.scope.viewer, this.scope.spaceId);
    return { id: subjectNodeId, kind: 'subject', title: this.subjectTitle ?? '' };
  }

  lecture(row: LectureRow): OfficialLectureView {
    const head = row.head_version_id ? versionOf(this.ctx, row.head_version_id) : null;
    this.preload([row.uploaded_by, row.approved_by]);
    return {
      id: row.id,
      space_id: this.scope.spaceId,
      subject: this.subject(row.subject_node_id),
      title: row.title,
      lecture_no: row.lecture_no,
      lecture_no_origin: row.lecture_no_origin,
      held_on: row.held_on,
      status: row.status,
      head_version: head ? { id: head.id, version_no: head.version_no, page_count: head.page_count, processing_status: head.processing_status } : null,
      uploaded_by: this.user(row.uploaded_by),
      approved: row.approved_by && row.approved_at !== null ? { by: this.user(row.approved_by), at: row.approved_at } : null,
      // publications arrive with step 3; a count the viewer could not open is never shown
      counts: { explanations: 0 },
      updated_at: row.updated_at,
    };
  }

  versions(row: LectureRow): Array<OfficialVersionView & OfficialVersionUploader> {
    const rows = this.ctx.db.all<VersionRow & { p_version_id: string | null; published_by: string | null; published_at: number | null; change_note: string | null; previous_version_id: string | null; p_kind: string | null; page_map_status: string | null; up_by: string | null; up_kind: string | null }>(
      `SELECT v.id, v.source_id, v.version_no, v.kind, v.file_id, v.original_file_id, v.display_file_id, v.content_hash, v.format, v.file_name, v.page_count,
              v.processing_status, v.created_at,
              p.version_id AS p_version_id, p.published_by, p.published_at, p.change_note, p.previous_version_id, p.kind AS p_kind, p.page_map_status,
              u.uploaded_by AS up_by, u.kind AS up_kind
       FROM source_version v
       LEFT JOIN official_version_publish p ON p.version_id = v.id
       LEFT JOIN official_version_upload u ON u.version_id = v.id
       WHERE v.source_id = ? ORDER BY v.version_no DESC`,
      [row.source_id],
    );
    this.preload(rows.flatMap((r) => [r.published_by, r.up_by]));
    return rows
      .filter((r) => r.p_version_id !== null || seesDraftVersion(this.scope, row, r.up_by))
      .map((r) => ({
        id: r.id,
        version_no: r.version_no,
        kind: r.p_kind === 'correction' || r.up_kind === 'correction' || r.kind === 'owner_correction' ? 'correction' : 'upload',
        status: r.p_version_id === null ? 'draft' : r.id === row.head_version_id ? 'published' : 'superseded',
        file_name: r.file_name,
        page_count: r.page_count,
        processing_status: r.processing_status,
        published_at: r.published_at,
        published_by: r.published_by ? this.user(r.published_by) : null,
        change_note: r.change_note,
        previous_version_id: r.previous_version_id,
        page_map_status: r.p_version_id !== null && r.previous_version_id ? ((r.page_map_status as OfficialVersionView['page_map_status']) ?? null) : null,
        uploaded_by: r.up_by ? this.user(r.up_by) : null,
      }));
  }

  detail(row: LectureRow): OfficialLectureDetail {
    return {
      ...this.lecture(row),
      versions: this.versions(row),
      withdrawn: row.status === 'withdrawn' && row.withdrawn_reason ? { reason: row.withdrawn_reason, note_ar: row.withdrawn_note ?? '', at: row.withdrawn_at ?? row.updated_at } : null,
    };
  }
}
