// The existing read routes re-mounted on a subject space for official content (P1-T5 step 1; ARCHITECTURE_DELTA §5.5
// «sources (read)», «processing», versions thumbnails / TOC / files, `GET /files/:id`). Their ids name a source, a
// version, a page or a file — not a lecture — so every handler FIRST resolves the official lecture or subject
// attachment that owns the id in THIS space and applies its rules (review W2-step0 R12):
//   * a draft (lecture, version or attachment) only for the subject's official moderators and its uploader;
//   * after a rights takedown nothing of the lecture's files or text, only the page placeholders (sizes, labels);
//   * an id that is not in this space, or that belongs to nothing the viewer may see, answers «not found» — the same
//     body as a missing id.
// The answers are produced by the existing services (sources, versions, files) running in the space binding.
import type { PageRegionsResponse, PrintedTocView, ProcessingStatusResponse, ReprocessResponse, SourceDetail, SourcePagesResponse, VersionFilesResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { SourcesService } from '../sources/service';
import { printedToc } from '../versions/toc';
import { versionFiles } from '../versions/rendition';
import { attachmentBySource, attachmentVisible } from './subject';
import { getLecture, type LectureRow, lectureResource, notFound, publishOf, type SpaceScope, versionOf, versionVisibleTo, type VersionRow } from './store';

export type Owner =
  | { kind: 'lecture'; lecture: LectureRow }
  | { kind: 'attachment'; attachment: NonNullable<ReturnType<typeof attachmentBySource>> };

const AR = {
  immutable: 'الإصدار المنشور لا يتغير؛ لتصحيح نصه استخدم «تصحيح»، فيُنشأ إصدار جديد.',
  moderators: 'هذا الإجراء لمشرف المادة فقط.',
};

export class SpaceReads {
  private readonly sources: SourcesService;

  constructor(private readonly ctx: AppContext) {
    this.sources = new SourcesService(ctx);
  }

  ownerOfSource(sourceId: string): Owner | null {
    const lecture = this.ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [sourceId]);
    if (lecture) return { kind: 'lecture', lecture };
    const attachment = attachmentBySource(this.ctx, sourceId);
    return attachment ? { kind: 'attachment', attachment } : null;
  }

  /** The owner of a source, if the viewer may see it (404 otherwise). */
  visibleOwner(scope: SpaceScope, sourceId: string): Owner {
    const owner = this.ownerOfSource(sourceId);
    if (!owner) throw notFound();
    if (owner.kind === 'lecture') {
      if (!this.ctx.authz.can(scope.viewer, 'view', lectureResource(scope, owner.lecture)).allowed) throw notFound();
    } else if (!attachmentVisible(scope, owner.attachment)) throw notFound();
    return owner;
  }

  /** May the viewer see this version of the owner? Lectures: published versions, drafts for moderators / uploader. */
  private versionVisible(scope: SpaceScope, owner: Owner, v: VersionRow): boolean {
    if (owner.kind === 'attachment') return true;
    return versionVisibleTo(this.ctx, scope, owner.lecture, v.id);
  }

  /** A version (and its owner) the viewer may see — 404 otherwise. */
  visibleVersion(scope: SpaceScope, versionId: string): { owner: Owner; version: VersionRow } {
    const v = versionOf(this.ctx, versionId);
    if (!v) throw notFound();
    const owner = this.visibleOwner(scope, v.source_id);
    if (!this.versionVisible(scope, owner, v)) throw notFound();
    return { owner, version: v };
  }

  private takenDown(owner: Owner): boolean {
    return owner.kind === 'lecture' && owner.lecture.takedown_at !== null;
  }

  private requireModerator(scope: SpaceScope): void {
    if (!scope.powers.officialModerator) throw new AppError('FORBIDDEN', AR.moderators, 403);
  }

  // ───────── sources ─────────

  sourceDetail(scope: SpaceScope, sourceId: string): SourceDetail {
    const owner = this.visibleOwner(scope, sourceId);
    const d = this.sources.detail(sourceId);
    const versions = d.versions.filter((v) => this.versionVisible(scope, owner, versionOf(this.ctx, v.id)!));
    return { ...d, versions, links: [], path: [] };
  }

  pages(scope: SpaceScope, sourceId: string, versionId: string): SourcePagesResponse {
    const { owner, version } = this.visibleVersion(scope, versionId);
    if (version.source_id !== sourceId) throw notFound();
    void owner; // the pages stay readable after a takedown: they are the placeholders students' notes sit on
    return this.sources.pages(sourceId, versionId);
  }

  regions(scope: SpaceScope, pageId: string): PageRegionsResponse {
    const page = this.ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_page WHERE id = ?', [pageId]);
    if (!page) throw notFound();
    const { owner } = this.visibleVersion(scope, page.version_id);
    if (this.takenDown(owner)) throw notFound();
    return this.sources.regions(pageId);
  }

  processing(scope: SpaceScope, versionId: string): ProcessingStatusResponse {
    this.requireModerator(scope);
    this.visibleVersion(scope, versionId);
    return this.sources.processing(versionId);
  }

  reprocess(scope: SpaceScope, versionId: string, pageIndexes: number[] | undefined): ReprocessResponse {
    this.requireModerator(scope);
    const { owner } = this.visibleVersion(scope, versionId);
    if (this.takenDown(owner)) throw notFound();
    // a published official version is immutable (§6.7): re-processing would rewrite its regions under pinned citations
    if (owner.kind === 'lecture' && publishOf(this.ctx, versionId)) throw new AppError('CONFLICT', AR.immutable, 409);
    return { job: this.sources.reprocess(versionId, pageIndexes) };
  }

  // ───────── versions ─────────

  toc(scope: SpaceScope, versionId: string): PrintedTocView {
    const { owner } = this.visibleVersion(scope, versionId);
    if (this.takenDown(owner)) throw notFound();
    return printedToc(this.ctx, versionId);
  }

  files(scope: SpaceScope, versionId: string): VersionFilesResponse {
    this.visibleVersion(scope, versionId);
    return versionFiles(this.ctx, versionId);
  }

  /** The page a thumbnail is asked for, with what is needed to render it (null when it may not be seen). */
  thumbnailPage(scope: SpaceScope, pageId: string): { page_index: number; kind: string; render_file_id: string | null; format: string; file_id: string | null; display_file_id: string | null } {
    const p = this.ctx.db.get<{ version_id: string; page_index: number; kind: string; render_file_id: string | null }>('SELECT version_id, page_index, kind, render_file_id FROM source_page WHERE id = ?', [pageId]);
    if (!p) throw notFound();
    const { owner, version } = this.visibleVersion(scope, p.version_id);
    if (this.takenDown(owner)) throw notFound();
    return { page_index: p.page_index, kind: p.kind, render_file_id: p.render_file_id, format: version.format, file_id: version.file_id, display_file_id: version.display_file_id };
  }

  // ───────── files ─────────

  /**
   * The version a stored file of this space belongs to, through the columns that hold official files (versions,
   * pages, the DOCX rendition, figure crops). A file id that is not an official file of a visible version is «not
   * found» — even if the row exists (a draft's file, a withdrawn attachment's file, a takedown).
   */
  fileVisible(scope: SpaceScope, fileId: string): void {
    const versions = new Set<string>();
    for (const r of this.ctx.db.all<{ v: string }>('SELECT id AS v FROM source_version WHERE file_id = ? OR original_file_id = ? OR display_file_id = ?', [fileId, fileId, fileId])) versions.add(r.v);
    for (const r of this.ctx.db.all<{ v: string }>('SELECT version_id AS v FROM source_page WHERE render_file_id = ? OR thumbnail_file_id = ?', [fileId, fileId])) versions.add(r.v);
    for (const r of this.ctx.db.all<{ v: string }>('SELECT version_id AS v FROM version_rendition WHERE file_id = ?', [fileId])) versions.add(r.v);
    for (const r of this.ctx.db.all<{ v: string | null }>('SELECT version_id AS v FROM image_asset WHERE file_id = ?', [fileId])) if (r.v) versions.add(r.v);
    for (const v of versions) {
      try {
        const { owner } = this.visibleVersion(scope, v);
        if (this.takenDown(owner)) continue;
        if (owner.kind === 'attachment' && owner.attachment.status === 'withdrawn' && !scope.powers.officialModerator) continue;
        this.ctx.authz.assert(scope.viewer, 'view', { type: 'file', db: `s:${scope.spaceId}`, fileId });
        return;
      } catch (e) {
        if (e instanceof AppError && e.status === 404) continue;
        throw e;
      }
    }
    throw new AppError('NOT_FOUND', 'الملف غير موجود أو لم يعد متاحًا.', 404);
  }

  /** The lecture of a version, when it is one (for callers that need its row). */
  lectureOf(versionId: string): LectureRow | null {
    const v = versionOf(this.ctx, versionId);
    return v ? (this.ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [v.source_id]) ?? null) : null;
  }

  lecture(id: string): LectureRow | null {
    return getLecture(this.ctx, id);
  }
}
