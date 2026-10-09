import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditListResponse } from '@medlevo/shared';
import { parseQuery } from '../../lib/http';
import type { ModuleOptions } from '../../context';

export { AuditLog, type AuditRecordInput, redactSecrets } from './audit';

const listQuery = z.object({
  entity_type: z.string().min(1).max(64).optional(),
  entity_id: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().min(1).max(64).optional(),
});

export default async function auditModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;
  app.get('/', async (req): Promise<AuditListResponse> => {
    const q = parseQuery(listQuery, req);
    return ctx.audit.list({ entityType: q.entity_type, entityId: q.entity_id, limit: q.limit, before: q.before });
  });
}
