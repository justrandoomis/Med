// Jobs API (Control Center → Processing).
//   GET  /api/jobs?status=a,b&kind=&parent_job_id=&limit=&before=
//   GET  /api/jobs/:id
//   POST /api/jobs/:id/cancel
//   POST /api/jobs/:id/retry
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JOB_STATUSES, type JobsListResponse, type JobStatus, type JobView } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseParams, parseQuery } from '../../lib/http';

export { JobQueue, type JobDefinition, type JobRun, type EnqueueOptions, type JobFilter, type PartialResult } from './queue';

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(JOB_STATUSES))),
  kind: z.string().min(1).max(64).optional(),
  parent_job_id: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().min(1).max(64).optional(),
});
const idParams = z.object({ id: z.string().min(1).max(64) });

export default async function jobsModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;

  app.get('/', async (req): Promise<JobsListResponse> => {
    const q = parseQuery(listQuery, req);
    return ctx.jobs.list({
      status: q.status.length ? (q.status as JobStatus[]) : undefined,
      kind: q.kind,
      parentJobId: q.parent_job_id,
      limit: q.limit,
      before: q.before,
    });
  });

  app.get('/:id', async (req): Promise<JobView> => {
    const { id } = parseParams(idParams, req);
    const job = ctx.jobs.get(id);
    if (!job) throw new AppError('NOT_FOUND', 'المهمة غير موجودة.', 404);
    return job;
  });

  app.post('/:id/cancel', async (req): Promise<JobView> => {
    const { id } = parseParams(idParams, req);
    const job = ctx.jobs.cancel(id);
    ctx.audit.record({ entityType: 'processing_job', entityId: id, action: 'cancel', summary: `إلغاء مهمة ${job.kind}` });
    return job;
  });

  app.post('/:id/retry', async (req): Promise<JobView> => {
    const { id } = parseParams(idParams, req);
    const job = ctx.jobs.retry(id);
    ctx.audit.record({ entityType: 'processing_job', entityId: id, action: 'retry', summary: `إعادة محاولة مهمة ${job.kind}` });
    return job;
  });
}
