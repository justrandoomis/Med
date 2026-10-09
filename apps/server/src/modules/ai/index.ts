// AI module: orchestrator + status endpoint (Control Center → Intelligence).
//   GET /api/ai/status → AiStatusResponse (configured, provider, per-task availability, estimated budget)
//   GET /api/ai/usage?limit= → recent usage records (no prompt text is ever stored)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiStatusResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { fromJson } from '../../db/db';
import { parseQuery } from '../../lib/http';

export { AiOrchestrator, AI_RULES_VERSION, extractJson, type GenerateStructuredRequest, type GenerateStructuredResult } from './orchestrator';
export { createProviderFromConfig } from './providers';
export { buildPrompt, UNTRUSTED_POLICY } from './prompt';
export type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage, ProviderImage, UntrustedBlock } from './types';

const usageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

interface UsageRow {
  id: string;
  job_id: string | null;
  task: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  latency_ms: number | null;
  status: string;
  source_version_ids_json: string | null;
  rules_version: string | null;
  verification_status: string | null;
  request_ref: string | null;
  created_at: number;
}

export default async function aiModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;

  app.get('/status', async (): Promise<AiStatusResponse> => ctx.ai.status());

  app.get('/usage', async (req) => {
    const q = parseQuery(usageQuery, req);
    const rows = ctx.db.all<UsageRow>('SELECT * FROM usage_record ORDER BY id DESC LIMIT ?', [q.limit]);
    return {
      records: rows.map(({ source_version_ids_json, ...r }) => ({ ...r, source_version_ids: fromJson<string[]>(source_version_ids_json, []) })),
      note_ar: 'التكاليف تقديرية محسوبة من عدد الرموز، وليست فاتورة المزود.',
    };
  });
}
