// Source registry service (§06, §07, §18). Metadata is only what the file or the owner provides —
// nothing is invented. Every write is audited.
import {
  PROCESS_JOB_KIND,
  type JobView,
  type PageRegionsResponse,
  type PatchSourceRequest,
  type ProcessingStatusResponse,
  type ProcessingSummary,
  type SourceDetail,
  type SourceLinkView,
  type SourcePagesResponse,
  type SourceSummary,
  type SourceType,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { contextOf, pathTo } from '../library/service';
import { enqueueProcessing, processingRegistered } from './upload';
import {
  type PageRow,
  type RegionRow,
  SOURCE_JOINED_SELECT,
  type SourceJoinedRow,
  type SourceRow,
  tagsByEntity,
  toPageView,
  toRegionView,
  toSourceSummary,
  toVersionView,
  type VersionRow,
} from './views';

export const SOURCE_AR = 'المصدر';

export function getSourceRow(ctx: AppContext, id: string): SourceRow {
  const row = ctx.db.get<SourceRow>('SELECT * FROM source WHERE id = ?', [id]);
  if (!row) throw Errors.notFound(SOURCE_AR);
  return row;
}

export function getVersionRow(ctx: AppContext, id: string): VersionRow {
  const row = ctx.db.get<VersionRow>('SELECT * FROM source_version WHERE id = ?', [id]);
  if (!row) throw Errors.notFound('نسخة المصدر');
  return row;
}

function metadataSnapshot(r: SourceRow) {
  return {
    title: r.title,
    source_type: r.source_type,
    source_type_origin: r.source_type_origin,
    node_id: r.node_id,
    language: r.language,
    edition: r.edition,
    authors: fromJson(r.authors_json),
    publication_date: r.publication_date,
    original_url: r.original_url,
    lecture_kind: r.lecture_kind,
    lecture_kind_origin: r.lecture_kind_origin,
    priority: r.priority,
    selection_reason: r.selection_reason,
    metadata_status: r.metadata_status,
    is_favorite: r.is_favorite === 1,
  };
}

export class SourcesService {
  constructor(private readonly ctx: AppContext) {}

  summary(id: string): SourceSummary & { source_type_origin: 'auto' | 'owner' } {
    const row = this.ctx.db.get<SourceJoinedRow>(`${SOURCE_JOINED_SELECT} WHERE s.id = ?`, [id]);
    if (!row) throw Errors.notFound(SOURCE_AR);
    return { ...toSourceSummary(row, tagsByEntity(this.ctx.db, 'source', [id]).get(id) ?? []), source_type_origin: row.source_type_origin };
  }

  detail(id: string): SourceDetail & { source_type_origin: 'auto' | 'owner' } {
    const { ctx } = this;
    const row = getSourceRow(ctx, id);
    const versions = ctx.db.all<VersionRow>('SELECT * FROM source_version WHERE source_id = ? ORDER BY version_no DESC', [id]);
    const links = ctx.db.all<SourceLinkView>(
      `SELECT l.id, l.from_source_id, l.to_source_id, l.relation,
              o.title AS other_title, o.source_type AS other_type
       FROM source_link l JOIN source o ON o.id = CASE WHEN l.from_source_id = ? THEN l.to_source_id ELSE l.from_source_id END
       WHERE (l.from_source_id = ? OR l.to_source_id = ?) AND o.deleted_at IS NULL
       ORDER BY l.created_at`,
      [id, id, id],
    );
    return {
      ...this.summary(id),
      language: row.language,
      edition: row.edition,
      authors: fromJson<string[]>(row.authors_json),
      publication_date: row.publication_date,
      original_url: row.original_url,
      metadata_status: row.metadata_status,
      priority: row.priority,
      selection_reason: row.selection_reason,
      versions: versions.map((v) => toVersionView(v, row.frozen_version_id)),
      links,
      path: pathTo(ctx, row.node_id),
    };
  }

  pages(sourceId: string, versionId: string): SourcePagesResponse {
    const { ctx } = this;
    const src = getSourceRow(ctx, sourceId);
    const v = getVersionRow(ctx, versionId);
    if (v.source_id !== sourceId) throw Errors.notFound('نسخة المصدر');
    const pages = ctx.db.all<PageRow>('SELECT * FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]);
    return { version: toVersionView(v, src.frozen_version_id), pages: pages.map(toPageView) };
  }

  regions(pageId: string): PageRegionsResponse {
    const { ctx } = this;
    const page = ctx.db.get<PageRow>('SELECT * FROM source_page WHERE id = ?', [pageId]);
    if (!page) throw Errors.notFound('الصفحة');
    const regions = ctx.db.all<RegionRow>('SELECT * FROM source_region WHERE page_id = ? ORDER BY reading_order, created_at', [pageId]);
    return { page: toPageView(page), regions: regions.map(toRegionView) };
  }

  patch(id: string, p: PatchSourceRequest): SourceDetail {
    const { ctx } = this;
    ctx.db.tx(() => {
      const before = getSourceRow(ctx, id);
      if (before.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا لتعديله.', 409);
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        params.push(v);
      };
      if (p.title !== undefined) set('title', p.title);
      if (p.source_type !== undefined) {
        set('source_type', p.source_type);
        set('source_type_origin', 'owner');
      }
      if (p.language !== undefined) set('language', p.language);
      if (p.edition !== undefined) set('edition', p.edition);
      if (p.authors !== undefined) set('authors_json', p.authors && p.authors.length > 0 ? toJson(p.authors) : null);
      if (p.publication_date !== undefined) set('publication_date', p.publication_date);
      if (p.original_url !== undefined) set('original_url', p.original_url);
      if (p.lecture_kind !== undefined) {
        set('lecture_kind', p.lecture_kind);
        set('lecture_kind_origin', p.lecture_kind === null ? null : 'owner');
      }
      if (p.priority !== undefined) set('priority', p.priority);
      if (p.selection_reason !== undefined) set('selection_reason', p.selection_reason);
      if (p.metadata_status !== undefined) set('metadata_status', p.metadata_status);
      if (p.is_favorite !== undefined) set('is_favorite', p.is_favorite ? 1 : 0);
      if (p.node_id !== undefined && p.node_id !== before.node_id) {
        const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [p.node_id]);
        if (!node) throw new AppError('NOT_FOUND', 'المجلد الهدف غير موجود.', 404);
        if (node.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد الهدف في سلة المحذوفات.', 409);
        const c = contextOf(ctx, p.node_id);
        const order = (ctx.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM source WHERE node_id = ?', [p.node_id])?.m ?? 0) + 1024;
        set('node_id', p.node_id);
        set('subject_node_id', c.subject);
        set('course_node_id', c.course);
        set('sort_order', order);
      }
      // bibliographic fields entered by the owner → at least partial metadata (never claimed automatically)
      const biblio = [p.edition, p.authors, p.publication_date, p.original_url].some((x) => x !== undefined && x !== null && !(Array.isArray(x) && x.length === 0));
      if (biblio && p.metadata_status === undefined && before.metadata_status === 'unknown') set('metadata_status', 'partial');
      if (sets.length === 0) return;
      set('updated_at', ctx.clock.now());
      ctx.db.run(`UPDATE source SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      const after = getSourceRow(ctx, id);
      const moved = p.node_id !== undefined && p.node_id !== before.node_id;
      const renamed = p.title !== undefined && p.title !== before.title;
      ctx.audit.record({
        entityType: 'source',
        entityId: id,
        action: moved ? 'move' : renamed ? 'rename' : 'update',
        summary: moved ? `نقل «${after.title}»` : renamed ? `إعادة تسمية «${before.title}» إلى «${after.title}»` : `تعديل بيانات «${after.title}»`,
        before: metadataSnapshot(before),
        after: metadataSnapshot(after),
      });
    });
    return this.detail(id);
  }

  /** Reorder / move a source among the sources of a folder (drag & drop). */
  move(id: string, target: { node_id: string; before_id?: string; after_id?: string }): SourceSummary {
    const { ctx } = this;
    if (target.before_id && target.after_id) throw new AppError('BAD_REQUEST', 'حدّد موضعًا واحدًا فقط: قبل عنصر أو بعده.', 400);
    ctx.db.tx(() => {
      const src = getSourceRow(ctx, id);
      if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا ثم انقله.', 409);
      const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [target.node_id]);
      if (!node) throw new AppError('NOT_FOUND', 'المجلد الهدف غير موجود.', 404);
      if (node.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد الهدف في سلة المحذوفات.', 409);
      const siblings = ctx.db.all<{ id: string; sort_order: number }>(
        'SELECT id, sort_order FROM source WHERE node_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY sort_order, created_at',
        [target.node_id, id],
      );
      const anchor = target.before_id ?? target.after_id;
      let prev: number | null = null;
      let next: number | null = null;
      if (anchor) {
        const i = siblings.findIndex((s) => s.id === anchor);
        if (i === -1) throw new AppError('BAD_REQUEST', 'العنصر المرجعي للترتيب ليس داخل المجلد الهدف.', 400);
        if (target.before_id) {
          prev = i > 0 ? siblings[i - 1]!.sort_order : null;
          next = siblings[i]!.sort_order;
        } else {
          prev = siblings[i]!.sort_order;
          next = i + 1 < siblings.length ? siblings[i + 1]!.sort_order : null;
        }
        if (prev !== null && next !== null && next - prev < 1e-6) {
          siblings.forEach((s, k) => ctx.db.run('UPDATE source SET sort_order = ? WHERE id = ?', [(k + 1) * 1024, s.id]));
          return this.move(id, target);
        }
      } else {
        prev = siblings.length ? siblings[siblings.length - 1]!.sort_order : null;
      }
      const order = prev === null && next === null ? 1024 : prev === null ? next! - 1024 : next === null ? prev + 1024 : (prev + next) / 2;
      const c = contextOf(ctx, target.node_id);
      ctx.db.run('UPDATE source SET node_id = ?, subject_node_id = ?, course_node_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', [
        target.node_id,
        c.subject,
        c.course,
        order,
        ctx.clock.now(),
        id,
      ]);
      ctx.audit.record({
        entityType: 'source',
        entityId: id,
        action: 'move',
        summary: target.node_id === src.node_id ? `إعادة ترتيب «${src.title}»` : `نقل «${src.title}»`,
        before: { node_id: src.node_id, sort_order: src.sort_order },
        after: { node_id: target.node_id, sort_order: order },
      });
    });
    return this.summary(id);
  }

  markOpened(id: string): SourceSummary {
    const { ctx } = this;
    const src = getSourceRow(ctx, id);
    if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات.', 409);
    ctx.db.run('UPDATE source SET last_opened_at = ? WHERE id = ?', [ctx.clock.now(), id]);
    return this.summary(id);
  }

  /** Source Freeze (§18): pin the version study tools use. Never changed automatically. */
  freeze(id: string, versionId: string | null): SourceDetail {
    const { ctx } = this;
    ctx.db.tx(() => {
      const src = getSourceRow(ctx, id);
      if (versionId !== null) {
        const v = getVersionRow(ctx, versionId);
        if (v.source_id !== id) throw new AppError('BAD_REQUEST', 'النسخة المختارة لا تنتمي إلى هذا المصدر.', 400);
      }
      if (src.frozen_version_id === versionId) return;
      ctx.db.run('UPDATE source SET frozen_version_id = ?, updated_at = ? WHERE id = ?', [versionId, ctx.clock.now(), id]);
      const no = versionId ? ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [versionId])?.version_no : null;
      ctx.audit.record({
        entityType: 'source',
        entityId: id,
        action: versionId ? 'freeze' : 'unfreeze',
        summary: versionId ? `تثبيت النسخة ${no} من «${src.title}» للدراسة` : `إلغاء تثبيت نسخة «${src.title}» (تتبع أدوات الدراسة أحدث نسخة)`,
        before: { frozen_version_id: src.frozen_version_id },
        after: { frozen_version_id: versionId },
      });
    });
    return this.detail(id);
  }

  setArchived(id: string, archived: boolean): SourceSummary {
    const { ctx } = this;
    ctx.db.tx(() => {
      const src = getSourceRow(ctx, id);
      if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات.', 409);
      if ((src.archived_at !== null) === archived) return;
      const now = ctx.clock.now();
      ctx.db.run('UPDATE source SET archived_at = ?, updated_at = ? WHERE id = ?', [archived ? now : null, now, id]);
      ctx.audit.record({ entityType: 'source', entityId: id, action: archived ? 'archive' : 'unarchive', summary: archived ? `أرشفة «${src.title}»` : `إخراج «${src.title}» من الأرشيف` });
    });
    return this.summary(id);
  }

  addLink(fromId: string, toId: string, relation: SourceLinkView['relation']): SourceLinkView {
    const { ctx } = this;
    if (fromId === toId) throw new AppError('BAD_REQUEST', 'لا يمكن ربط المصدر بنفسه.', 400);
    let linkId = '';
    ctx.db.tx(() => {
      const from = getSourceRow(ctx, fromId);
      const to = ctx.db.get<SourceRow>('SELECT * FROM source WHERE id = ?', [toId]);
      if (!to) throw new AppError('NOT_FOUND', 'المصدر المراد ربطه غير موجود.', 404);
      if (from.deleted_at !== null || to.deleted_at !== null) throw new AppError('CONFLICT', 'أحد المصدرين في سلة المحذوفات.', 409);
      const existing = ctx.db.get<{ id: string }>('SELECT id FROM source_link WHERE from_source_id = ? AND to_source_id = ? AND relation = ?', [fromId, toId, relation]);
      if (existing) {
        linkId = existing.id;
        return;
      }
      linkId = newId(ctx.clock.now());
      ctx.db.run('INSERT INTO source_link (id, from_source_id, to_source_id, relation, created_at) VALUES (?, ?, ?, ?, ?)', [linkId, fromId, toId, relation, ctx.clock.now()]);
      ctx.audit.record({ entityType: 'source', entityId: fromId, action: 'link', summary: `ربط «${from.title}» بـ«${to.title}»`, after: { link_id: linkId, to_source_id: toId, relation } });
    });
    return this.detail(fromId).links.find((l) => l.id === linkId)!;
  }

  removeLink(sourceId: string, linkId: string): void {
    const { ctx } = this;
    ctx.db.tx(() => {
      const link = ctx.db.get<{ id: string; from_source_id: string; to_source_id: string; relation: string }>(
        'SELECT * FROM source_link WHERE id = ? AND (from_source_id = ? OR to_source_id = ?)',
        [linkId, sourceId, sourceId],
      );
      if (!link) throw Errors.notFound('الرابط');
      ctx.db.run('DELETE FROM source_link WHERE id = ?', [linkId]);
      ctx.audit.record({ entityType: 'source', entityId: sourceId, action: 'unlink', summary: 'إزالة رابط بين مصدرين', before: link });
    });
  }

  trash(id: string): SourceSummary {
    const { ctx } = this;
    ctx.db.tx(() => {
      const src = getSourceRow(ctx, id);
      if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات بالفعل.', 409);
      const now = ctx.clock.now();
      ctx.db.run('UPDATE source SET deleted_at = ?, trash_root_id = NULL, updated_at = ? WHERE id = ?', [now, now, id]);
      ctx.audit.record({ entityType: 'source', entityId: id, action: 'trash', summary: `نقل «${src.title}» إلى سلة المحذوفات` });
    });
    return this.summary(id);
  }

  restore(id: string, opts: { node_id?: string }): SourceSummary {
    const { ctx } = this;
    ctx.db.tx(() => {
      const src = getSourceRow(ctx, id);
      if (src.deleted_at === null) throw new AppError('CONFLICT', 'هذا المصدر ليس في سلة المحذوفات.', 409);
      if (src.trash_root_id) {
        const root = ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [src.trash_root_id]);
        throw new AppError('CONFLICT', `حُذف هذا المصدر ضمن «${root?.title ?? 'مجلد آخر'}». استعد ذلك المجلد لاستعادة ما بداخله.`, 409, {
          reason: 'trashed_with_parent',
          trash_root_id: src.trash_root_id,
        });
      }
      let nodeId = opts.node_id ?? src.node_id;
      const node = nodeId ? ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [nodeId]) : undefined;
      if (!nodeId || !node || node.deleted_at !== null) {
        if (opts.node_id) throw new AppError('CONFLICT', 'المجلد المختار للاستعادة في سلة المحذوفات أو غير موجود.', 409);
        throw new AppError('CONFLICT', 'المجلد الأصلي لهذا المصدر في سلة المحذوفات أو لم يعد موجودًا. اختر مجلدًا للاستعادة.', 409, { reason: 'parent_in_trash' });
      }
      const c = contextOf(ctx, nodeId);
      ctx.db.run('UPDATE source SET deleted_at = NULL, trash_root_id = NULL, node_id = ?, subject_node_id = ?, course_node_id = ?, updated_at = ? WHERE id = ?', [
        nodeId,
        c.subject,
        c.course,
        ctx.clock.now(),
        id,
      ]);
      nodeId = nodeId as string;
      ctx.audit.record({ entityType: 'source', entityId: id, action: 'restore', summary: `استعادة «${src.title}» من سلة المحذوفات`, after: { node_id: nodeId } });
    });
    return this.summary(id);
  }

  reprocess(versionId: string, pageIndexes?: number[]): JobView {
    const { ctx } = this;
    const v = getVersionRow(ctx, versionId);
    const src = getSourceRow(ctx, v.source_id);
    if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات.', 409);
    if (v.format === 'audio') throw Errors.featureDisabled('معالجة التسجيلات الصوتية (التفريغ النصي) غير متاحة في هذا الإصدار.');
    if (!processingRegistered(ctx)) throw Errors.featureDisabled('وحدة معالجة المستندات غير متاحة في هذا الإصدار من الخادم، لذلك لا يمكن إعادة المعالجة الآن.');
    if (pageIndexes && v.page_count !== null && pageIndexes.some((i) => i >= v.page_count!)) {
      throw new AppError('BAD_REQUEST', 'رقم صفحة خارج حدود هذه النسخة.', 400);
    }
    const job = enqueueProcessing(ctx, versionId, 'reprocess', pageIndexes)!;
    ctx.audit.record({
      entityType: 'source_version',
      entityId: versionId,
      action: 'reprocess',
      summary: pageIndexes?.length ? `إعادة معالجة ${pageIndexes.length} صفحة من «${src.title}»` : `إعادة معالجة «${src.title}»`,
      after: { job_id: job.id, page_indexes: pageIndexes ?? null },
    });
    return job;
  }

  processing(versionId: string): ProcessingStatusResponse {
    const { ctx } = this;
    const v = getVersionRow(ctx, versionId);
    const jobRow = ctx.db.get<{ id: string }>(
      `SELECT id FROM processing_job WHERE kind = ? AND json_valid(input_json) AND json_extract(input_json, '$.version_id') = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [PROCESS_JOB_KIND, versionId],
    );
    const job = jobRow ? ctx.jobs.get(jobRow.id) : null;
    return { summary: fromJson<ProcessingSummary>(v.processing_summary_json), job: job ?? null };
  }

  /** Library listing of sources in one folder (helper for clients that don't need the whole tree). */
  inNode(nodeId: string): SourceSummary[] {
    const rows = this.ctx.db.all<SourceJoinedRow>(`${SOURCE_JOINED_SELECT} WHERE s.node_id = ? AND s.deleted_at IS NULL ORDER BY s.sort_order, s.created_at`, [nodeId]);
    const tags = tagsByEntity(this.ctx.db, 'source', rows.map((r) => r.id));
    return rows.map((r) => toSourceSummary(r, tags.get(r.id) ?? []));
  }
}

export function sourceTypeOf(ctx: AppContext, id: string): SourceType {
  return getSourceRow(ctx, id).source_type;
}
