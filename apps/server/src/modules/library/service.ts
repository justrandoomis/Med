// Library service (§05): one personal tree of notebooks / folders / subjects / courses / sections.
// Kinds are personal study organisation, never institutions (§02, AC-01).
import type { FavoritesResponse, LibraryNodeKind, LibraryNodeView, LibraryTreeResponse, NodeCover, SourceSummary } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { AppError, Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import {
  type NodeRow,
  SOURCE_JOINED_SELECT,
  type SourceJoinedRow,
  tagsByEntity,
  toNodeView,
  toSourceSummary,
} from '../sources/views';
import { findTemplate } from './templates';

export const NODE_NOT_FOUND_AR = 'المجلد';

export interface NodeInput {
  parent_id?: string | null;
  kind?: LibraryNodeKind;
  title?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  cover?: NodeCover | null;
  template?: string | null;
  sort_mode?: NodeRow['sort_mode'];
  is_favorite?: boolean;
}

const SORT_STEP = 1024;
const MIN_GAP = 1e-6;

/** Fractional index strictly between prev and next (either may be missing). */
export function orderBetween(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return SORT_STEP;
  if (prev === null) return next! - SORT_STEP;
  if (next === null) return prev + SORT_STEP;
  return (prev + next) / 2;
}

export function getNodeRow(ctx: AppContext, id: string): NodeRow {
  const row = ctx.db.get<NodeRow>('SELECT * FROM library_node WHERE id = ?', [id]);
  if (!row) throw Errors.notFound(NODE_NOT_FOUND_AR);
  return row;
}

/** ids of the node and all its descendants */
export function subtreeIds(ctx: AppContext, rootId: string): string[] {
  return ctx.db
    .all<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT n.id FROM library_node n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub`,
      [rootId],
    )
    .map((r) => r.id);
}

/** Path from the root to the node (inclusive). */
export function pathTo(ctx: AppContext, nodeId: string | null): Array<{ id: string; title: string; kind: LibraryNodeKind }> {
  if (!nodeId) return [];
  const rows = ctx.db.all<{ id: string; title: string; kind: LibraryNodeKind; depth: number }>(
    `WITH RECURSIVE up(id, parent_id, title, kind, depth) AS (
       SELECT id, parent_id, title, kind, 0 FROM library_node WHERE id = ?
       UNION SELECT n.id, n.parent_id, n.title, n.kind, up.depth + 1 FROM library_node n JOIN up ON n.id = up.parent_id
       WHERE up.depth < 200)
     SELECT id, title, kind, depth FROM up ORDER BY depth DESC`,
    [nodeId],
  );
  return rows.map(({ id, title, kind }) => ({ id, title, kind }));
}

/** Nearest ancestor-or-self of kind 'subject' / 'course' (derived context of a source). */
export function contextOf(ctx: AppContext, nodeId: string | null): { subject: string | null; course: string | null } {
  const path = pathTo(ctx, nodeId);
  let subject: string | null = null;
  let course: string | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const p = path[i]!;
    if (!subject && p.kind === 'subject') subject = p.id;
    if (!course && p.kind === 'course') course = p.id;
  }
  return { subject, course };
}

/** Recompute subject/course of every source inside the subtree (after a move or a kind change). */
export function recomputeSubtreeContext(ctx: AppContext, rootId: string): void {
  const nodes = subtreeIds(ctx, rootId);
  const cache = new Map<string, { subject: string | null; course: string | null }>();
  for (const nodeId of nodes) {
    const sources = ctx.db.all<{ id: string; subject_node_id: string | null; course_node_id: string | null }>(
      'SELECT id, subject_node_id, course_node_id FROM source WHERE node_id = ?',
      [nodeId],
    );
    if (sources.length === 0) continue;
    let c = cache.get(nodeId);
    if (!c) {
      c = contextOf(ctx, nodeId);
      cache.set(nodeId, c);
    }
    for (const s of sources) {
      if (s.subject_node_id !== c.subject || s.course_node_id !== c.course) {
        ctx.db.run('UPDATE source SET subject_node_id = ?, course_node_id = ? WHERE id = ?', [c.subject, c.course, s.id]);
      }
    }
  }
}

function siblingOrders(ctx: AppContext, parentId: string | null, excludeId: string): Array<{ id: string; sort_order: number }> {
  return ctx.db.all<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM library_node WHERE parent_id IS ? AND id <> ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
    [parentId, excludeId],
  );
}

/** Compute the sort_order for placing a node among its new siblings (renumbers when gaps run out). */
function placeAmong(ctx: AppContext, parentId: string | null, movingId: string, opts: { before_id?: string; after_id?: string }): number {
  let siblings = siblingOrders(ctx, parentId, movingId);
  const anchorId = opts.before_id ?? opts.after_id;
  const locate = () => {
    if (!anchorId) {
      const last = siblings[siblings.length - 1];
      return { prev: last ? last.sort_order : null, next: null };
    }
    const i = siblings.findIndex((s) => s.id === anchorId);
    if (i === -1) throw new AppError('BAD_REQUEST', 'العنصر المرجعي للترتيب ليس داخل المجلد الهدف.', 400);
    return opts.before_id
      ? { prev: i > 0 ? siblings[i - 1]!.sort_order : null, next: siblings[i]!.sort_order }
      : { prev: siblings[i]!.sort_order, next: i + 1 < siblings.length ? siblings[i + 1]!.sort_order : null };
  };
  let { prev, next } = locate();
  if (prev !== null && next !== null && next - prev < MIN_GAP) {
    // fractional indices exhausted locally → renumber the siblings evenly, then place again
    siblings.forEach((s, i) => ctx.db.run('UPDATE library_node SET sort_order = ? WHERE id = ?', [(i + 1) * SORT_STEP, s.id]));
    siblings = siblingOrders(ctx, parentId, movingId);
    ({ prev, next } = locate());
  }
  return orderBetween(prev, next);
}

function assertParentUsable(ctx: AppContext, parentId: string | null): void {
  if (parentId === null) return;
  const parent = ctx.db.get<NodeRow>('SELECT * FROM library_node WHERE id = ?', [parentId]);
  if (!parent) throw new AppError('NOT_FOUND', 'المجلد الهدف غير موجود.', 404);
  if (parent.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد الهدف في سلة المحذوفات. استعده أولًا أو اختر مكانًا آخر.', 409);
}

function snapshot(r: NodeRow) {
  return { title: r.title, kind: r.kind, parent_id: r.parent_id, color: r.color, icon: r.icon, cover: r.cover_json, template: r.template, sort_mode: r.sort_mode, is_favorite: r.is_favorite === 1, description: r.description };
}

export class LibraryService {
  constructor(private readonly ctx: AppContext) {}

  nodeView(id: string): LibraryNodeView {
    const row = getNodeRow(this.ctx, id);
    return toNodeView(row, tagsByEntity(this.ctx.db, 'library_node', [id]).get(id) ?? []);
  }

  create(input: Required<Pick<NodeInput, 'kind' | 'title'>> & NodeInput): LibraryNodeView {
    const { ctx } = this;
    const now = ctx.clock.now();
    const id = newId(now);
    ctx.db.tx(() => {
      const parentId = input.parent_id ?? null;
      assertParentUsable(ctx, parentId);
      if (input.template && !findTemplate(input.template)) throw new AppError('BAD_REQUEST', 'قالب الدراسة غير معروف.', 400);
      const order = placeAmong(ctx, parentId, id, {});
      ctx.db.run(
        `INSERT INTO library_node (id, parent_id, kind, title, description, color, icon, cover_json, template, sort_order, sort_mode, is_favorite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          parentId,
          input.kind,
          input.title,
          input.description ?? null,
          input.color ?? null,
          input.icon ?? null,
          input.cover ? toJson(input.cover) : null,
          input.template ?? null,
          order,
          input.sort_mode ?? 'manual',
          input.is_favorite ? 1 : 0,
          now,
          now,
        ],
      );
      ctx.audit.record({ entityType: 'library_node', entityId: id, action: 'create', summary: `إنشاء «${input.title}»`, after: { kind: input.kind, parent_id: parentId } });
    });
    return this.nodeView(id);
  }

  patch(id: string, patch: NodeInput): LibraryNodeView {
    const { ctx } = this;
    ctx.db.tx(() => {
      const before = getNodeRow(ctx, id);
      if (patch.template && !findTemplate(patch.template)) throw new AppError('BAD_REQUEST', 'قالب الدراسة غير معروف.', 400);
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        params.push(v);
      };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.color !== undefined) set('color', patch.color);
      if (patch.icon !== undefined) set('icon', patch.icon);
      if (patch.cover !== undefined) set('cover_json', patch.cover ? toJson(patch.cover) : null);
      if (patch.template !== undefined) set('template', patch.template);
      if (patch.sort_mode !== undefined) set('sort_mode', patch.sort_mode);
      if (patch.is_favorite !== undefined) set('is_favorite', patch.is_favorite ? 1 : 0);
      if (sets.length === 0) return;
      set('updated_at', ctx.clock.now());
      ctx.db.run(`UPDATE library_node SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      if (patch.kind !== undefined && patch.kind !== before.kind) recomputeSubtreeContext(ctx, id);
      const after = getNodeRow(ctx, id);
      const renamed = patch.title !== undefined && patch.title !== before.title;
      ctx.audit.record({
        entityType: 'library_node',
        entityId: id,
        action: renamed && sets.length === 2 ? 'rename' : 'update',
        summary: renamed ? `إعادة تسمية «${before.title}» إلى «${after.title}»` : `تعديل «${after.title}»`,
        before: snapshot(before),
        after: snapshot(after),
      });
    });
    return this.nodeView(id);
  }

  move(id: string, target: { parent_id: string | null; before_id?: string; after_id?: string }): LibraryNodeView {
    const { ctx } = this;
    if (target.before_id && target.after_id) throw new AppError('BAD_REQUEST', 'حدّد موضعًا واحدًا فقط: قبل عنصر أو بعده.', 400);
    ctx.db.tx(() => {
      const node = getNodeRow(ctx, id);
      if (node.deleted_at !== null) throw new AppError('CONFLICT', 'هذا العنصر في سلة المحذوفات. استعده أولًا ثم انقله.', 409);
      const parentId = target.parent_id;
      if (parentId !== null) {
        if (parentId === id || subtreeIds(ctx, id).includes(parentId)) {
          throw new AppError('BAD_REQUEST', 'لا يمكن نقل المجلد إلى داخله أو إلى مجلد موجود بداخله.', 400, { reason: 'cycle' });
        }
      }
      assertParentUsable(ctx, parentId);
      const order = placeAmong(ctx, parentId, id, target);
      ctx.db.run('UPDATE library_node SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', [parentId, order, ctx.clock.now(), id]);
      if (parentId !== node.parent_id) recomputeSubtreeContext(ctx, id);
      ctx.audit.record({
        entityType: 'library_node',
        entityId: id,
        action: 'move',
        summary: parentId === node.parent_id ? `إعادة ترتيب «${node.title}»` : `نقل «${node.title}»`,
        before: { parent_id: node.parent_id, sort_order: node.sort_order },
        after: { parent_id: parentId, sort_order: order },
      });
    });
    return this.nodeView(id);
  }

  setArchived(id: string, archived: boolean): LibraryNodeView {
    const { ctx } = this;
    ctx.db.tx(() => {
      const node = getNodeRow(ctx, id);
      if (node.deleted_at !== null) throw new AppError('CONFLICT', 'هذا العنصر في سلة المحذوفات.', 409);
      if ((node.archived_at !== null) === archived) return;
      const now = ctx.clock.now();
      ctx.db.run('UPDATE library_node SET archived_at = ?, updated_at = ? WHERE id = ?', [archived ? now : null, now, id]);
      ctx.audit.record({
        entityType: 'library_node',
        entityId: id,
        action: archived ? 'archive' : 'unarchive',
        summary: archived ? `أرشفة «${node.title}»` : `إخراج «${node.title}» من الأرشيف`,
      });
    });
    return this.nodeView(id);
  }

  /** Move the node + its subtree (nodes and sources) to the trash. Nothing is deleted. */
  trash(id: string): LibraryNodeView {
    const { ctx } = this;
    ctx.db.tx(() => {
      const node = getNodeRow(ctx, id);
      if (node.deleted_at !== null) throw new AppError('CONFLICT', 'هذا العنصر في سلة المحذوفات بالفعل.', 409);
      const now = ctx.clock.now();
      const ids = subtreeIds(ctx, id).filter((x) => x !== id);
      ctx.db.run('UPDATE library_node SET deleted_at = ?, trash_root_id = NULL, updated_at = ? WHERE id = ?', [now, now, id]);
      let hiddenNodes = 0;
      let hiddenSources = 0;
      for (const childId of ids) {
        hiddenNodes += ctx.db.run('UPDATE library_node SET deleted_at = ?, trash_root_id = ? WHERE id = ? AND deleted_at IS NULL', [now, id, childId]).changes;
      }
      for (const nodeId of [id, ...ids]) {
        hiddenSources += ctx.db.run('UPDATE source SET deleted_at = ?, trash_root_id = ? WHERE node_id = ? AND deleted_at IS NULL', [now, id, nodeId]).changes;
      }
      ctx.audit.record({
        entityType: 'library_node',
        entityId: id,
        action: 'trash',
        summary: `نقل «${node.title}» إلى سلة المحذوفات`,
        after: { hidden_nodes: hiddenNodes, hidden_sources: hiddenSources },
      });
    });
    return this.nodeView(id);
  }

  restore(id: string, opts: { parent_id?: string | null }): LibraryNodeView {
    const { ctx } = this;
    ctx.db.tx(() => {
      const node = getNodeRow(ctx, id);
      if (node.deleted_at === null) throw new AppError('CONFLICT', 'هذا العنصر ليس في سلة المحذوفات.', 409);
      if (node.trash_root_id) {
        const root = ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [node.trash_root_id]);
        throw new AppError('CONFLICT', `حُذف هذا العنصر ضمن «${root?.title ?? 'مجلد آخر'}». استعد ذلك المجلد لاستعادة ما بداخله.`, 409, {
          reason: 'trashed_with_parent',
          trash_root_id: node.trash_root_id,
        });
      }
      let parentId = node.parent_id;
      if (opts.parent_id !== undefined) parentId = opts.parent_id;
      if (parentId !== null) {
        const parent = ctx.db.get<NodeRow>('SELECT * FROM library_node WHERE id = ?', [parentId]);
        if (!parent || parent.deleted_at !== null) {
          if (opts.parent_id === undefined) {
            throw new AppError('CONFLICT', 'المجلد الأصلي لهذا العنصر في سلة المحذوفات أو لم يعد موجودًا. اختر مكانًا للاستعادة.', 409, { reason: 'parent_in_trash' });
          }
          assertParentUsable(ctx, parentId);
        }
        if (subtreeIds(ctx, id).includes(parentId)) throw new AppError('BAD_REQUEST', 'لا يمكن الاستعادة إلى داخل العنصر نفسه.', 400);
      }
      const now = ctx.clock.now();
      const order = parentId !== node.parent_id ? placeAmong(ctx, parentId, id, {}) : node.sort_order;
      ctx.db.run('UPDATE library_node SET deleted_at = NULL, trash_root_id = NULL, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', [parentId, order, now, id]);
      ctx.db.run('UPDATE library_node SET deleted_at = NULL, trash_root_id = NULL WHERE trash_root_id = ?', [id]);
      ctx.db.run('UPDATE source SET deleted_at = NULL, trash_root_id = NULL WHERE trash_root_id = ?', [id]);
      if (parentId !== node.parent_id) recomputeSubtreeContext(ctx, id);
      ctx.audit.record({ entityType: 'library_node', entityId: id, action: 'restore', summary: `استعادة «${node.title}» من سلة المحذوفات`, after: { parent_id: parentId } });
    });
    return this.nodeView(id);
  }

  createFromTemplate(templateKey: string, parentId: string | null, title?: string): { node: LibraryNodeView; created: number } {
    const { ctx } = this;
    const tpl = findTemplate(templateKey);
    if (!tpl) throw new AppError('NOT_FOUND', 'قالب الدراسة غير موجود.', 404);
    const now = ctx.clock.now();
    let created = 0;
    const rootId = newId(now);
    ctx.db.tx(() => {
      assertParentUsable(ctx, parentId);
      const insert = (id: string, parent: string | null, kind: LibraryNodeKind, t: string, order: number, extra: Partial<{ template: string; cover: NodeCover; icon: string }> = {}) => {
        ctx.db.run(
          `INSERT INTO library_node (id, parent_id, kind, title, cover_json, icon, template, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, parent, kind, t, extra.cover ? toJson(extra.cover) : null, extra.icon ?? null, extra.template ?? null, order, now, now],
        );
        created++;
      };
      insert(rootId, parentId, 'subject', title?.trim() || tpl.title_ar, placeAmong(ctx, parentId, rootId, {}), { template: tpl.key, cover: tpl.cover, icon: tpl.icon });
      const walk = (parent: string, folders: typeof tpl.skeleton) => {
        folders.forEach((f, i) => {
          const id = newId(now);
          insert(id, parent, f.kind, f.title, (i + 1) * SORT_STEP);
          if (f.children) walk(id, f.children);
        });
      };
      walk(rootId, tpl.skeleton);
      ctx.audit.record({ entityType: 'library_node', entityId: rootId, action: 'create', summary: `إنشاء «${title?.trim() || tpl.title_ar}» من قالب ${tpl.title_en}`, after: { template: tpl.key, created } });
    });
    return { node: this.nodeView(rootId), created };
  }

  /** The library tree. Trashed and archived items are only included on request. */
  tree(opts: { archived: boolean; trash: boolean }): LibraryTreeResponse {
    const { ctx } = this;
    const rows = ctx.db.all<NodeRow>('SELECT * FROM library_node ORDER BY sort_order, created_at');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const archivedCache = new Map<string, boolean>();
    const inArchived = (id: string | null, depth = 0): boolean => {
      if (!id || depth > 500) return false;
      const cached = archivedCache.get(id);
      if (cached !== undefined) return cached;
      const r = byId.get(id);
      const v = !!r && (r.archived_at !== null || inArchived(r.parent_id, depth + 1));
      archivedCache.set(id, v);
      return v;
    };
    const visibleNode = (r: NodeRow) => (opts.trash || r.deleted_at === null) && (opts.archived || !inArchived(r.id));
    const nodes = rows.filter(visibleNode);
    const nodeTags = tagsByEntity(ctx.db, 'library_node');
    const sourceRows = ctx.db.all<SourceJoinedRow>(`${SOURCE_JOINED_SELECT} ORDER BY s.sort_order, s.created_at`);
    const sources = sourceRows.filter(
      (s) => (opts.trash || s.deleted_at === null) && (opts.archived || (s.archived_at === null && !inArchived(s.node_id))),
    );
    const sourceTags = tagsByEntity(ctx.db, 'source');
    return {
      nodes: nodes.map((n) => toNodeView(n, nodeTags.get(n.id) ?? [])),
      sources: sources.map((s) => toSourceSummary(s, sourceTags.get(s.id) ?? [])),
    };
  }

  recent(limit: number): SourceSummary[] {
    const rows = this.ctx.db.all<SourceJoinedRow>(
      `${SOURCE_JOINED_SELECT} WHERE s.deleted_at IS NULL AND s.last_opened_at IS NOT NULL ORDER BY s.last_opened_at DESC LIMIT ?`,
      [limit],
    );
    const tags = tagsByEntity(this.ctx.db, 'source', rows.map((r) => r.id));
    return rows.map((r) => toSourceSummary(r, tags.get(r.id) ?? []));
  }

  favorites(): FavoritesResponse {
    const nodes = this.ctx.db.all<NodeRow>('SELECT * FROM library_node WHERE is_favorite = 1 AND deleted_at IS NULL ORDER BY title COLLATE NOCASE');
    const sources = this.ctx.db.all<SourceJoinedRow>(`${SOURCE_JOINED_SELECT} WHERE s.is_favorite = 1 AND s.deleted_at IS NULL ORDER BY s.title COLLATE NOCASE`);
    const nt = tagsByEntity(this.ctx.db, 'library_node', nodes.map((n) => n.id));
    const st = tagsByEntity(this.ctx.db, 'source', sources.map((s) => s.id));
    return { nodes: nodes.map((n) => toNodeView(n, nt.get(n.id) ?? [])), sources: sources.map((s) => toSourceSummary(s, st.get(s.id) ?? [])) };
  }
}
