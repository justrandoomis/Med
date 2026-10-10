// Clinical cases / OSCE / Viva (track D3) — §42, §44 signals. See docs/modules/cases-media.md.
//
//   GET    /                                  CaseListResponse (cases + capabilities: generation / AI judge / voice)
//   POST   /                                  CaseSaveRequest → CaseDetailView (owner authoring, no AI needed)
//   GET    /:id · PUT /:id · DELETE /:id · POST /:id/restore     detail / new version / trash / restore
//   POST   /evidence/suggest                  evidence candidates for a sentence (deterministic retrieval in the Source Lock)
//   POST   /generate                          AI generation (job 'cases.generate'; capability ai.cases)
//   POST   /:id/attempts                      start an attempt (idempotent by attempt_id)
//   GET    /attempts?case_id=&limit=          attempt history
//   GET    /attempts/:attemptId               CaseRunView (only what has been revealed)
//   POST   /attempts/:attemptId/events        append an event (idempotent by event_id) → CaseEventResponse
//   GET    /attempts/:attemptId/report        CaseReportView (after finishing)
//   GET    /signals?since=                    case / OSCE signals in the Weakness Center shape
// Capability: `ai.cases` → available when a provider is configured (the registry reports requires_configuration
// otherwise). Authoring, playing and assessing are deterministic and always available.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CASE_KINDS, type CaseAttemptListResponse, type CaseDetailView, type CaseEventResponse, type CaseListResponse, type CaseReportView, type CaseRunView, type CaseSignalsResponse, type CaseSummaryView, type CaseEvidenceSuggestResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseParams, parseQuery, RATE_LIMITS } from '../../lib/http';
import { restoreCase, saveCase, suggestEvidence, trashCase } from './authoring';
import { listAttempts, postEvent, reportView, runView, startAttempt } from './attempts';
import { registerCaseGenerationJob, requestCaseGeneration } from './generate';
import { caseSignals } from './signals';
import { getCaseRow, type CaseRow } from './store';
import { casesCapabilities, detailView, summaryView } from './views';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });
const attemptParams = z.object({ attemptId: id });
const listQuery = z.object({ kind: z.enum(CASE_KINDS).optional(), trash: z.enum(['0', '1']).optional() }).strict();
const attemptsQuery = z.object({ case_id: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const signalsQuery = z.object({ since: z.coerce.number().int().min(0).optional() }).strict();

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('ai.cases', 'available');
  registerCaseGenerationJob(ctx);
  const ai = { config: { rateLimit: RATE_LIMITS.ai } };

  app.get('/', async (req): Promise<CaseListResponse> => {
    const q = parseQuery(listQuery, req);
    const rows = ctx.db.all<CaseRow>(
      `SELECT * FROM clinical_case WHERE ${q.trash === '1' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'} ${q.kind ? 'AND kind = ?' : ''} ORDER BY updated_at DESC, id DESC LIMIT 500`,
      q.kind ? [q.kind] : [],
    );
    return { cases: rows.map((r) => summaryView(ctx, r)), capabilities: casesCapabilities(ctx) };
  });

  app.post('/', async (req): Promise<CaseDetailView> => saveCase(ctx, req.body ?? {}, null));

  app.post('/evidence/suggest', async (req): Promise<CaseEvidenceSuggestResponse> => suggestEvidence(ctx, req.body ?? {}));

  app.post('/generate', ai, async (req): Promise<{ case: CaseSummaryView }> => ({ case: requestCaseGeneration(ctx, req.body ?? {}) }));

  app.get('/signals', async (req): Promise<CaseSignalsResponse> => caseSignals(ctx, { since: parseQuery(signalsQuery, req).since }));

  app.get('/attempts', async (req): Promise<CaseAttemptListResponse> => {
    const q = parseQuery(attemptsQuery, req);
    return listAttempts(ctx, q.case_id ?? null, q.limit);
  });

  app.get('/attempts/:attemptId', async (req): Promise<CaseRunView> => runView(ctx, parseParams(attemptParams, req).attemptId));

  app.post('/attempts/:attemptId/events', async (req): Promise<CaseEventResponse> => postEvent(ctx, parseParams(attemptParams, req).attemptId, req.body ?? {}));

  app.get('/attempts/:attemptId/report', async (req): Promise<CaseReportView> => reportView(ctx, parseParams(attemptParams, req).attemptId));

  app.get('/:id', async (req): Promise<CaseDetailView> => detailView(ctx, getCaseRow(ctx, parseParams(idParams, req).id)));

  app.put('/:id', async (req): Promise<CaseDetailView> => saveCase(ctx, req.body ?? {}, parseParams(idParams, req).id));

  app.delete('/:id', async (req): Promise<{ ok: true }> => {
    trashCase(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });

  app.post('/:id/restore', async (req): Promise<CaseDetailView> => restoreCase(ctx, parseParams(idParams, req).id));

  app.post('/:id/attempts', async (req): Promise<CaseRunView> => startAttempt(ctx, parseParams(idParams, req).id, req.body ?? {}));
}
