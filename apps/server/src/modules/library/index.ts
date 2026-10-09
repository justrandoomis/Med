// Library module (§05, §23, AC-01): /api/library
//   GET    /tree?include=archived,trash          → LibraryTreeResponse
//   GET    /nodes/:id                            → NodeResponse
//   GET    /nodes/:id/links                      → links among sources inside the subtree (course view)
//   POST   /nodes                                → create (kind, parent, title, cover tokens, template, sort_mode, favorite)
//   PATCH  /nodes/:id                            → rename / recolor / kind / sort mode / favorite (ids & links unchanged)
//   POST   /nodes/:id/move {parent_id, before_id?|after_id?}  (cycle-safe, fractional sort_order)
//   POST   /nodes/:id/archive | /unarchive
//   POST   /nodes/:id/trash | /restore {parent_id?}
//   GET    /nodes/:id/impact?mode=purge|trash    → ImpactReport (+ confirm_token for purge)
//   DELETE /nodes/:id?confirm_token=…            → permanent purge (only from trash, token required)
//   POST   /nodes/from-template                  → create a subject from a study template
//   GET    /templates · /recent · /favorites
//   tags:   GET/POST /tags · PATCH/DELETE /tags/:id · POST /tags/:id/links · DELETE /tags/:id/links?entity_type&entity_id
//   topics: GET/POST /topics · PATCH/DELETE /topics/:id · GET /topic-links · POST /topics/:id/links
//           PATCH/DELETE /topic-links/:id
// Single owner: no institutions, roles or members anywhere.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COVER_COLORS,
  COVER_STYLES,
  LIBRARY_NODE_KINDS,
  SORT_MODES,
  type FavoritesResponse,
  type FromTemplateResponse,
  type ImpactReport,
  type LibraryTreeResponse,
  type NodeLinksResponse,
  type NodeResponse,
  type RecentResponse,
  type TagsResponse,
  type TemplatesResponse,
  type TopicLinksResponse,
  type TopicsResponse,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { buildImpactReport, executePurge, type ImpactCounts } from '../sources/purge';
import { getNodeRow, LibraryService, subtreeIds } from './service';
import {
  createTag,
  createTopic,
  decideTopicLink,
  deleteTag,
  deleteTopic,
  deleteTopicLink,
  linkTag,
  listTags,
  listTopicLinks,
  listTopics,
  ownerLinkTopic,
  patchTag,
  patchTopic,
  unlinkTag,
} from './tags';
import { STUDY_TEMPLATES } from './templates';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });
const title = z.string().trim().min(1, 'العنوان مطلوب.').max(200);
const tokenName = z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/);
const cover = z
  .object({
    style: z.enum(COVER_STYLES),
    color: z.enum(COVER_COLORS),
    symbol: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

const nodeFields = {
  kind: z.enum(LIBRARY_NODE_KINDS),
  title,
  description: z.string().trim().max(2000).nullable().optional(),
  color: z.enum(COVER_COLORS).nullable().optional(),
  icon: tokenName.nullable().optional(),
  cover: cover.nullable().optional(),
  template: tokenName.nullable().optional(),
  sort_mode: z.enum(SORT_MODES).optional(),
  is_favorite: z.boolean().optional(),
};
const createBody = z.object({ parent_id: id.nullable(), ...nodeFields }).strict();
const patchBody = z
  .object(nodeFields)
  .partial()
  .strict();
const moveBody = z.object({ parent_id: id.nullable(), before_id: id.optional(), after_id: id.optional() }).strict();
const restoreBody = z.object({ parent_id: id.nullable().optional() }).strict();
const treeQuery = z.object({
  include: z
    .string()
    .max(64)
    .optional()
    .transform((s) => new Set((s ?? '').split(',').map((x) => x.trim()).filter(Boolean))),
});
const impactQuery = z.object({ mode: z.enum(['purge', 'trash']).default('purge') });
const purgeQuery = z.object({ confirm_token: z.string().max(1024).optional() });
const templateBody = z.object({ template_key: tokenName, parent_id: id.nullable(), title: title.optional() }).strict();
const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const tagBody = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(COVER_COLORS).nullable().optional() }).strict();
const tagPatch = tagBody.partial().strict();
const tagLink = z.object({ entity_type: z.enum(['library_node', 'source']), entity_id: id }).strict();
const topicBody = z
  .object({ title: z.string().trim().min(1).max(200), title_ar: z.string().trim().max(200).nullable().optional(), parent_topic_id: id.nullable().optional() })
  .strict();
const topicPatch = topicBody.partial().strict();
const topicLinkBody = z.object({ entity_type: z.string().trim().min(1).max(40).regex(/^[a-z_]+$/), entity_id: id }).strict();
const topicLinksQuery = z.object({
  entity_type: z.string().max(40).optional(),
  entity_id: id.optional(),
  topic_id: id.optional(),
  status: z.enum(['suggested', 'accepted', 'rejected']).optional(),
});
const decideBody = z.object({ status: z.enum(['accepted', 'rejected', 'suggested']) }).strict();

export default async function libraryModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('library', 'available');
  const lib = new LibraryService(ctx);

  app.get('/tree', async (req): Promise<LibraryTreeResponse> => {
    const q = parseQuery(treeQuery, req);
    return lib.tree({ archived: q.include.has('archived'), trash: q.include.has('trash') });
  });

  app.get('/templates', async (): Promise<TemplatesResponse> => ({ templates: STUDY_TEMPLATES }));

  app.get('/recent', async (req): Promise<RecentResponse> => ({ sources: lib.recent(parseQuery(recentQuery, req).limit) }));

  app.get('/favorites', async (): Promise<FavoritesResponse> => lib.favorites());

  app.get('/nodes/:id', async (req): Promise<NodeResponse> => ({ node: lib.nodeView(parseParams(idParams, req).id) }));

  app.get('/nodes/:id/links', async (req): Promise<NodeLinksResponse> => {
    const { id: nodeId } = parseParams(idParams, req);
    getNodeRow(ctx, nodeId);
    const ids = subtreeIds(ctx, nodeId);
    const links = ctx.db.all<NodeLinksResponse['links'][number]>(
      `SELECT l.id, l.from_source_id, l.to_source_id, l.relation FROM source_link l
       JOIN source a ON a.id = l.from_source_id JOIN source b ON b.id = l.to_source_id
       WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
         AND (a.node_id IN (SELECT value FROM json_each(?)) OR b.node_id IN (SELECT value FROM json_each(?)))
       ORDER BY l.created_at`,
      [JSON.stringify(ids), JSON.stringify(ids)],
    );
    return { links };
  });

  app.post('/nodes', async (req): Promise<NodeResponse> => {
    const b = parseBody(createBody, req);
    return { node: lib.create(b) };
  });

  app.post('/nodes/from-template', async (req): Promise<FromTemplateResponse> => {
    const b = parseBody(templateBody, req);
    return lib.createFromTemplate(b.template_key, b.parent_id, b.title);
  });

  app.patch('/nodes/:id', async (req): Promise<NodeResponse> => {
    const { id: nodeId } = parseParams(idParams, req);
    return { node: lib.patch(nodeId, parseBody(patchBody, req)) };
  });

  app.post('/nodes/:id/move', async (req): Promise<NodeResponse> => {
    const { id: nodeId } = parseParams(idParams, req);
    return { node: lib.move(nodeId, parseBody(moveBody, req)) };
  });

  app.post('/nodes/:id/archive', async (req): Promise<NodeResponse> => ({ node: lib.setArchived(parseParams(idParams, req).id, true) }));
  app.post('/nodes/:id/unarchive', async (req): Promise<NodeResponse> => ({ node: lib.setArchived(parseParams(idParams, req).id, false) }));
  app.post('/nodes/:id/trash', async (req): Promise<NodeResponse> => ({ node: lib.trash(parseParams(idParams, req).id) }));
  app.post('/nodes/:id/restore', async (req): Promise<NodeResponse> => {
    const { id: nodeId } = parseParams(idParams, req);
    return { node: lib.restore(nodeId, parseBody(restoreBody, req)) };
  });

  app.get('/nodes/:id/impact', async (req): Promise<ImpactReport> => {
    const { id: nodeId } = parseParams(idParams, req);
    const { mode } = parseQuery(impactQuery, req);
    getNodeRow(ctx, nodeId);
    return buildImpactReport(ctx, 'library_node', nodeId, { nodeId }, mode);
  });

  app.delete('/nodes/:id', async (req): Promise<{ ok: true; removed: ImpactCounts; removed_files: number }> => {
    const { id: nodeId } = parseParams(idParams, req);
    const { confirm_token } = parseQuery(purgeQuery, req);
    const node = getNodeRow(ctx, nodeId);
    if (node.deleted_at === null) {
      throw new AppError('CONFLICT', 'الحذف النهائي متاح فقط من سلة المحذوفات. انقل العنصر إلى السلة أولًا.', 409, { reason: 'not_in_trash' });
    }
    const r = executePurge(ctx, 'library_node', nodeId, { nodeId }, confirm_token, {
      summary: `«${node.title}» وكل ما بداخله`,
      before: { title: node.title, kind: node.kind, parent_id: node.parent_id },
    });
    return { ok: true, removed: r.counts, removed_files: r.removedFiles };
  });

  // ───────── tags ─────────
  app.get('/tags', async (): Promise<TagsResponse> => ({ tags: listTags(ctx) }));
  app.post('/tags', async (req) => {
    const b = parseBody(tagBody, req);
    return { tag: createTag(ctx, b.name, b.color ?? null) };
  });
  app.patch('/tags/:id', async (req) => ({ tag: patchTag(ctx, parseParams(idParams, req).id, parseBody(tagPatch, req)) }));
  app.delete('/tags/:id', async (req) => {
    deleteTag(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });
  app.post('/tags/:id/links', async (req) => {
    const b = parseBody(tagLink, req);
    linkTag(ctx, parseParams(idParams, req).id, b.entity_type, b.entity_id);
    return { ok: true };
  });
  app.delete('/tags/:id/links', async (req) => {
    const q = parseQuery(tagLink, req);
    unlinkTag(ctx, parseParams(idParams, req).id, q.entity_type, q.entity_id);
    return { ok: true };
  });

  // ───────── topics ─────────
  app.get('/topics', async (): Promise<TopicsResponse> => ({ topics: listTopics(ctx) }));
  app.post('/topics', async (req) => ({ topic: createTopic(ctx, parseBody(topicBody, req)) }));
  app.patch('/topics/:id', async (req) => ({ topic: patchTopic(ctx, parseParams(idParams, req).id, parseBody(topicPatch, req)) }));
  app.delete('/topics/:id', async (req) => {
    deleteTopic(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });
  app.get('/topic-links', async (req): Promise<TopicLinksResponse> => ({ links: listTopicLinks(ctx, parseQuery(topicLinksQuery, req)) }));
  app.post('/topics/:id/links', async (req) => {
    const b = parseBody(topicLinkBody, req);
    return { link: ownerLinkTopic(ctx, parseParams(idParams, req).id, b.entity_type, b.entity_id) };
  });
  app.patch('/topic-links/:id', async (req) => ({ link: decideTopicLink(ctx, parseParams(idParams, req).id, parseBody(decideBody, req).status) }));
  app.delete('/topic-links/:id', async (req) => {
    deleteTopicLink(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });
}
