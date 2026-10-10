// Quality ops routes of the Control Center (track F5, §56 · §57), mounted under /api/control with the owner session
// (+ CSRF on mutations) like every control route:
//   GET    /evaluation                       latest evaluation report + run history + catalogue counts (+ how to run)
//   GET    /evaluation/runs/:id              one stored report (JSON)
//   GET    /evaluation/runs/:id/report.md    the same report as Markdown (download)
//   GET    /health?days=14                   daily trends: citation / verification failures, sync rejections / conflicts
//   GET    /client-errors                    the client error sink (redacted, grouped, with counts)
//   POST   /client-errors                    {errors: ClientErrorReport[]} from the browser (batched, redacted twice)
//   DELETE /client-errors                    clear the sink (audited)
// The evaluation itself runs from the CLI (`npm run eval`) in a throwaway data directory; this module only shows
// its recorded reports — nothing here processes fixtures in the owner's library.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLIENT_ERROR_KINDS, type ClientErrorReport } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { clearClientErrors, listClientErrors, storeClientErrors } from './client-errors';
import { syncCatalogue, evaluationOverview, getRun } from './evaluation/store';
import { healthTrends } from './trends';

const RUN_ID = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

const errorReport = z
  .object({
    kind: z.enum(CLIENT_ERROR_KINDS),
    message: z.string().max(4000),
    stack: z.string().max(16_000).nullish(),
    route: z.string().max(2000).nullish(),
    app_version: z.string().max(80).nullish(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
const batchBody = z.object({ errors: z.array(errorReport).min(1).max(50) }).strict();

export function registerQualityRoutes(app: FastifyInstance, ctx: AppContext): void {
  // the EvaluationCase store mirrors the code catalogue (upsert by id; removed cases are retired, never deleted)
  try {
    syncCatalogue(ctx.db, ctx.clock.now());
  } catch (e) {
    ctx.log.warn({ err: e }, 'control: syncing the evaluation catalogue failed');
  }

  app.get('/evaluation', async () => evaluationOverview(ctx.db));

  app.get('/evaluation/runs/:id', async (req) => {
    const r = getRun(ctx.db, parseParams(z.object({ id: RUN_ID }), req).id);
    if (!r) throw new AppError('NOT_FOUND', 'تقرير التقييم المطلوب غير موجود.', 404);
    return { report: r.report };
  });

  app.get('/evaluation/runs/:id/report.md', async (req, reply) => {
    const id = parseParams(z.object({ id: RUN_ID }), req).id;
    const r = getRun(ctx.db, id);
    if (!r) throw new AppError('NOT_FOUND', 'تقرير التقييم المطلوب غير موجود.', 404);
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="medlevo-${id}.md"`);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(r.markdown);
  });

  app.get('/health', async (req) => healthTrends(ctx, parseQuery(z.object({ days: z.coerce.number().int().min(7).max(60).default(14) }), req).days));

  app.get('/client-errors', async (req) => listClientErrors(ctx, parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req).limit));

  app.post('/client-errors', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req) => {
    const body = parseBody(batchBody, req);
    return storeClientErrors(ctx, body.errors as ClientErrorReport[], req.headers['user-agent']);
  });

  app.delete('/client-errors', async () => {
    const deleted = clearClientErrors(ctx);
    ctx.audit.record({ entityType: 'client_error', entityId: 'all', action: 'clear', summary: `مسح سجل أخطاء الواجهة (${deleted})` });
    return { deleted };
  });
}
