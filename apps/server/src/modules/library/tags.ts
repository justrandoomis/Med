// Tags (owner labels on nodes and sources) and topics (concept links; auto suggestions are
// correctable and the owner's decision persists — §05, §06).
import { TOPIC_ENTITY_TYPES, type TagView, type TopicEntityType, type TopicLinkView, type TopicView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';

export type TaggableType = 'library_node' | 'source';

function assertEntity(ctx: AppContext, type: TaggableType, id: string): void {
  const table = type === 'library_node' ? 'library_node' : 'source';
  if (!ctx.db.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, [id])) throw Errors.notFound(type === 'library_node' ? 'المجلد' : 'المصدر');
}

export function listTags(ctx: AppContext): Array<TagView & { usage: number }> {
  return ctx.db.all<TagView & { usage: number }>(
    `SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM tag_link l WHERE l.tag_id = t.id) AS usage
     FROM tag t ORDER BY t.name COLLATE NOCASE`,
  );
}

function tagView(ctx: AppContext, id: string): TagView {
  const t = ctx.db.get<TagView>('SELECT id, name, color FROM tag WHERE id = ?', [id]);
  if (!t) throw Errors.notFound('الوسم');
  return t;
}

export function createTag(ctx: AppContext, name: string, color: string | null): TagView {
  const existing = ctx.db.get<{ id: string }>('SELECT id FROM tag WHERE name = ? COLLATE NOCASE', [name]);
  if (existing) throw new AppError('CONFLICT', 'يوجد وسم بهذا الاسم بالفعل.', 409, { tag_id: existing.id });
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO tag (id, name, color, created_at) VALUES (?, ?, ?, ?)', [id, name, color, now]);
    ctx.audit.record({ entityType: 'tag', entityId: id, action: 'create', summary: `إنشاء الوسم «${name}»` });
  });
  return tagView(ctx, id);
}

export function patchTag(ctx: AppContext, id: string, patch: { name?: string; color?: string | null }): TagView {
  ctx.db.tx(() => {
    const before = tagView(ctx, id);
    if (patch.name !== undefined && patch.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = ctx.db.get('SELECT 1 AS x FROM tag WHERE name = ? COLLATE NOCASE AND id <> ?', [patch.name, id]);
      if (clash) throw new AppError('CONFLICT', 'يوجد وسم بهذا الاسم بالفعل.', 409);
    }
    ctx.db.run('UPDATE tag SET name = COALESCE(?, name), color = CASE WHEN ? THEN ? ELSE color END WHERE id = ?', [
      patch.name ?? null,
      patch.color !== undefined,
      patch.color ?? null,
      id,
    ]);
    ctx.audit.record({ entityType: 'tag', entityId: id, action: 'update', summary: `تعديل الوسم «${before.name}»`, before, after: tagView(ctx, id) });
  });
  return tagView(ctx, id);
}

export function deleteTag(ctx: AppContext, id: string): void {
  ctx.db.tx(() => {
    const t = tagView(ctx, id);
    ctx.db.run('DELETE FROM tag WHERE id = ?', [id]); // tag_link cascades
    ctx.audit.record({ entityType: 'tag', entityId: id, action: 'delete', summary: `حذف الوسم «${t.name}» (العناصر نفسها لم تُحذف)`, before: t });
  });
}

export function linkTag(ctx: AppContext, tagId: string, entityType: TaggableType, entityId: string): void {
  ctx.db.tx(() => {
    tagView(ctx, tagId);
    assertEntity(ctx, entityType, entityId);
    ctx.db.run('INSERT OR IGNORE INTO tag_link (tag_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?)', [tagId, entityType, entityId, ctx.clock.now()]);
    ctx.audit.record({ entityType, entityId, action: 'tag', summary: 'إضافة وسم', after: { tag_id: tagId } });
  });
}

export function unlinkTag(ctx: AppContext, tagId: string, entityType: TaggableType, entityId: string): void {
  ctx.db.tx(() => {
    const r = ctx.db.run('DELETE FROM tag_link WHERE tag_id = ? AND entity_type = ? AND entity_id = ?', [tagId, entityType, entityId]);
    if (r.changes > 0) ctx.audit.record({ entityType, entityId, action: 'untag', summary: 'إزالة وسم', before: { tag_id: tagId } });
  });
}

// ───────── topics ─────────
interface TopicRow {
  id: string;
  title: string;
  title_ar: string | null;
  parent_topic_id: string | null;
  concept_id: string | null;
  created_at: number;
  updated_at: number;
}

const toTopic = (r: TopicRow): TopicView => ({
  id: r.id,
  title: r.title,
  title_ar: r.title_ar,
  parent_topic_id: r.parent_topic_id,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export function listTopics(ctx: AppContext): TopicView[] {
  return ctx.db.all<TopicRow>('SELECT * FROM topic ORDER BY title COLLATE NOCASE').map(toTopic);
}

function topicRow(ctx: AppContext, id: string): TopicRow {
  const r = ctx.db.get<TopicRow>('SELECT * FROM topic WHERE id = ?', [id]);
  if (!r) throw Errors.notFound('الموضوع');
  return r;
}

function assertNoTopicCycle(ctx: AppContext, id: string, parentId: string | null): void {
  let cur = parentId;
  for (let i = 0; cur && i < 500; i++) {
    if (cur === id) throw new AppError('BAD_REQUEST', 'لا يمكن جعل الموضوع فرعًا من نفسه أو من أحد فروعه.', 400);
    cur = ctx.db.get<{ parent_topic_id: string | null }>('SELECT parent_topic_id FROM topic WHERE id = ?', [cur])?.parent_topic_id ?? null;
  }
}

export function createTopic(ctx: AppContext, input: { title: string; title_ar?: string | null; parent_topic_id?: string | null }): TopicView {
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    if (input.parent_topic_id) topicRow(ctx, input.parent_topic_id);
    ctx.db.run('INSERT INTO topic (id, title, title_ar, parent_topic_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      input.title,
      input.title_ar ?? null,
      input.parent_topic_id ?? null,
      now,
      now,
    ]);
    ctx.audit.record({ entityType: 'topic', entityId: id, action: 'create', summary: `إنشاء الموضوع «${input.title}»` });
  });
  return toTopic(topicRow(ctx, id));
}

export function patchTopic(ctx: AppContext, id: string, patch: { title?: string; title_ar?: string | null; parent_topic_id?: string | null }): TopicView {
  ctx.db.tx(() => {
    const before = topicRow(ctx, id);
    if (patch.parent_topic_id !== undefined) {
      if (patch.parent_topic_id) topicRow(ctx, patch.parent_topic_id);
      assertNoTopicCycle(ctx, id, patch.parent_topic_id);
    }
    ctx.db.run(
      `UPDATE topic SET title = COALESCE(?, title),
         title_ar = CASE WHEN ? THEN ? ELSE title_ar END,
         parent_topic_id = CASE WHEN ? THEN ? ELSE parent_topic_id END,
         updated_at = ? WHERE id = ?`,
      [patch.title ?? null, patch.title_ar !== undefined, patch.title_ar ?? null, patch.parent_topic_id !== undefined, patch.parent_topic_id ?? null, ctx.clock.now(), id],
    );
    ctx.audit.record({ entityType: 'topic', entityId: id, action: 'update', summary: `تعديل الموضوع «${before.title}»`, before: toTopic(before), after: toTopic(topicRow(ctx, id)) });
  });
  return toTopic(topicRow(ctx, id));
}

export function deleteTopic(ctx: AppContext, id: string): void {
  ctx.db.tx(() => {
    const t = topicRow(ctx, id);
    if (ctx.db.get('SELECT 1 AS x FROM topic WHERE parent_topic_id = ?', [id])) {
      throw new AppError('CONFLICT', 'لهذا الموضوع مواضيع فرعية. انقلها أو احذفها أولًا.', 409);
    }
    const links = ctx.db.run('DELETE FROM topic_link WHERE topic_id = ?', [id]).changes;
    ctx.db.run('UPDATE flashcard SET topic_id = NULL WHERE topic_id = ?', [id]);
    ctx.db.run('UPDATE weakness SET topic_id = NULL WHERE topic_id = ?', [id]);
    ctx.db.run('DELETE FROM topic WHERE id = ?', [id]);
    ctx.audit.record({ entityType: 'topic', entityId: id, action: 'delete', summary: `حذف الموضوع «${t.title}» وروابطه (${links})`, before: toTopic(t) });
  });
}

const LINK_SELECT = `SELECT l.id, l.topic_id, t.title AS topic_title, t.title_ar AS topic_title_ar, l.entity_type, l.entity_id, l.origin, l.status, l.created_at
  FROM topic_link l JOIN topic t ON t.id = l.topic_id`;

export function listTopicLinks(ctx: AppContext, filter: { entity_type?: string; entity_id?: string; topic_id?: string; status?: string }): TopicLinkView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.entity_type) {
    where.push('l.entity_type = ?');
    params.push(filter.entity_type);
  }
  if (filter.entity_id) {
    where.push('l.entity_id = ?');
    params.push(filter.entity_id);
  }
  if (filter.topic_id) {
    where.push('l.topic_id = ?');
    params.push(filter.topic_id);
  }
  if (filter.status) {
    where.push('l.status = ?');
    params.push(filter.status);
  }
  return ctx.db.all<TopicLinkView>(`${LINK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at`, params);
}

function linkView(ctx: AppContext, id: string): TopicLinkView {
  const l = ctx.db.get<TopicLinkView>(`${LINK_SELECT} WHERE l.id = ?`, [id]);
  if (!l) throw Errors.notFound('رابط الموضوع');
  return l;
}

const TOPIC_ENTITY_TABLES: Record<TopicEntityType, string> = {
  source: 'source',
  source_region: 'source_region',
  question: 'question',
  library_node: 'library_node',
  concept: 'concept',
  image_asset: 'image_asset',
  flashcard: 'flashcard',
  note: 'note',
};

/** A topic link must point at something real (known entity type, existing row) — track F2. */
function assertTopicEntity(ctx: AppContext, entityType: string, entityId: string): void {
  if (!(TOPIC_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new AppError('BAD_REQUEST', 'نوع العنصر غير مدعوم للربط بموضوع.', 400, { entity_type: entityType });
  }
  if (!ctx.db.get(`SELECT 1 AS x FROM ${TOPIC_ENTITY_TABLES[entityType as TopicEntityType]} WHERE id = ?`, [entityId])) throw Errors.notFound('العنصر المراد ربطه');
}

/** Owner links a topic: accepted immediately (or updates an existing suggestion to accepted). */
export function ownerLinkTopic(ctx: AppContext, topicId: string, entityType: string, entityId: string): TopicLinkView {
  let id = '';
  ctx.db.tx(() => {
    topicRow(ctx, topicId);
    assertTopicEntity(ctx, entityType, entityId);
    const existing = ctx.db.get<{ id: string }>('SELECT id FROM topic_link WHERE topic_id = ? AND entity_type = ? AND entity_id = ?', [topicId, entityType, entityId]);
    if (existing) {
      id = existing.id;
      ctx.db.run(`UPDATE topic_link SET status = 'accepted', origin = 'owner' WHERE id = ?`, [id]);
    } else {
      id = newId(ctx.clock.now());
      ctx.db.run(`INSERT INTO topic_link (id, topic_id, entity_type, entity_id, origin, status, created_at) VALUES (?, ?, ?, ?, 'owner', 'accepted', ?)`, [
        id,
        topicId,
        entityType,
        entityId,
        ctx.clock.now(),
      ]);
    }
    ctx.audit.record({ entityType: 'topic_link', entityId: id, action: 'accept', summary: 'ربط موضوع', after: { topic_id: topicId, entity_type: entityType, entity_id: entityId } });
  });
  return linkView(ctx, id);
}

/**
 * Automatic suggestion (used by processing/matching). NEVER overrides an existing link: a link the
 * owner rejected (or accepted) stays exactly as the owner decided. Returns null when one existed.
 */
export function suggestTopicLink(ctx: AppContext, topicId: string, entityType: string, entityId: string): TopicLinkView | null {
  const id = newId(ctx.clock.now());
  const r = ctx.db.run(
    `INSERT OR IGNORE INTO topic_link (id, topic_id, entity_type, entity_id, origin, status, created_at) VALUES (?, ?, ?, ?, 'auto', 'suggested', ?)`,
    [id, topicId, entityType, entityId, ctx.clock.now()],
  );
  return r.changes > 0 ? linkView(ctx, id) : null;
}

/** Owner decision on a link (accept / reject). The decision persists across later suggestions. */
export function decideTopicLink(ctx: AppContext, linkId: string, status: 'accepted' | 'rejected' | 'suggested'): TopicLinkView {
  ctx.db.tx(() => {
    const before = linkView(ctx, linkId);
    ctx.db.run('UPDATE topic_link SET status = ? WHERE id = ?', [status, linkId]);
    ctx.audit.record({
      entityType: 'topic_link',
      entityId: linkId,
      action: status === 'accepted' ? 'accept' : status === 'rejected' ? 'reject' : 'reset',
      summary: status === 'accepted' ? `قبول ربط الموضوع «${before.topic_title}»` : status === 'rejected' ? `رفض ربط الموضوع «${before.topic_title}»` : 'إعادة الرابط إلى اقتراح',
      before: { status: before.status },
      after: { status },
    });
  });
  return linkView(ctx, linkId);
}

export function deleteTopicLink(ctx: AppContext, linkId: string): void {
  ctx.db.tx(() => {
    const before = linkView(ctx, linkId);
    if (before.origin === 'auto') {
      // removing an automatic suggestion = rejecting it (so it is not suggested again)
      ctx.db.run(`UPDATE topic_link SET status = 'rejected' WHERE id = ?`, [linkId]);
    } else {
      ctx.db.run('DELETE FROM topic_link WHERE id = ?', [linkId]);
    }
    ctx.audit.record({ entityType: 'topic_link', entityId: linkId, action: 'unlink', summary: `إزالة ربط الموضوع «${before.topic_title}»`, before });
  });
}
