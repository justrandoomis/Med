// Annotations module (/api/annotations) — track B1. Owns annotation, annotation_target, note, note_page,
// ink_recognition, study_session, source_progress (ARCHITECTURE §2).
//  * sync entity handlers: annotation, note, note_page, study_session (merge policies in ./sync.ts)
//  * read APIs for the reader, the ink engine, offline download and Continue Studying
//  * reading progress (pages shown) — Reading Progress only, never mastery (§45)
import type {
  AnnotationsByTargetsResponse,
  LatestSessionResponse,
  NeedsReanchorResponse,
  NotesResponse,
  ReadingProgressView,
  RecentSessionsResponse,
  SourceAnnotationsResponse,
} from '@medlevo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { AnnotationsService, MAX_TARGET_KEYS } from './service';
import { registerAnnotationSync } from './sync';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const byTargetsQuery = z.object({
  keys: z.string().min(1).max(MAX_TARGET_KEYS * 80),
  include_deleted: z.enum(['0', '1', 'true', 'false']).optional(),
});
const sourceParams = z.object({ sourceId: ID });
const versionQuery = z.object({ version_id: ID.optional() });
const notesQuery = z.object({
  source_id: ID.optional(),
  node_id: ID.optional(),
  page_id: ID.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
const reanchorQuery = z.object({ source_id: ID.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const latestQuery = z.object({ source_id: ID });
const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) });
const progressBody = z
  .object({
    source_id: ID,
    version_id: ID,
    page_index: z.number().int().min(0).max(100_000).optional(),
    page_indexes: z.array(z.number().int().min(0).max(100_000)).max(2000).optional(),
  })
  .refine((b) => b.page_index !== undefined || (b.page_indexes && b.page_indexes.length > 0), {
    message: 'حدّد رقم الصفحة التي عُرضت (page_index أو page_indexes).',
  });

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  registerAnnotationSync(ctx.sync, ctx.db);
  const svc = new AnnotationsService(ctx);

  ctx.capabilities.set('workspace.reader', 'available');
  // The ink engine (web, features/workspace/ink) stores strokes locally first and syncs them through the
  // 'annotation' entity registered above. The ink track verifies the engine itself; pressure/tilt/palm
  // rejection are reported per device by the engine (§27), not promised here.
  ctx.capabilities.set('workspace.ink', 'available');

  app.get('/by-targets', async (req): Promise<AnnotationsByTargetsResponse> => {
    const q = parseQuery(byTargetsQuery, req);
    const keys = [...new Set(q.keys.split(',').map((k) => k.trim()).filter(Boolean))];
    if (keys.length > MAX_TARGET_KEYS) {
      throw new AppError('VALIDATION_FAILED', `عدد الصفحات المطلوبة في طلب واحد أكبر من الحد (${MAX_TARGET_KEYS}).`, 400);
    }
    return { annotations: svc.byTargets(keys, q.include_deleted === '1' || q.include_deleted === 'true') };
  });

  app.get('/source/:sourceId', async (req): Promise<SourceAnnotationsResponse> => {
    const { sourceId } = parseParams(sourceParams, req);
    const q = parseQuery(versionQuery, req);
    return svc.forSource(sourceId, q.version_id);
  });

  app.get('/notes', async (req): Promise<NotesResponse> => {
    const q = parseQuery(notesQuery, req);
    return { notes: svc.notes(q) };
  });

  app.get('/needs-reanchor', async (req): Promise<NeedsReanchorResponse> => {
    const q = parseQuery(reanchorQuery, req);
    return { items: svc.needsReanchor(q.source_id, q.limit) };
  });

  app.get('/sessions/latest', async (req): Promise<LatestSessionResponse> => {
    const q = parseQuery(latestQuery, req);
    return { session: svc.latestSession(q.source_id) };
  });

  app.get('/sessions/recent', async (req): Promise<RecentSessionsResponse> => {
    const q = parseQuery(recentQuery, req);
    return { items: svc.recentSessions(q.limit) };
  });

  app.post('/progress', async (req): Promise<ReadingProgressView> => {
    const b = parseBody(progressBody, req);
    const pages = [...new Set([...(b.page_indexes ?? []), ...(b.page_index !== undefined ? [b.page_index] : [])])];
    return svc.recordViewed(b.source_id, b.version_id, pages);
  });

  app.get('/progress/:sourceId', async (req): Promise<ReadingProgressView> => {
    const { sourceId } = parseParams(sourceParams, req);
    if (!ctx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
    return svc.progress(sourceId);
  });
}
