// Personal Control Center (track D2, §48 · §51 · §53 · §56 · §18 · §47; AC-03, AC-26). One owner, one calm center —
// no roles, no admin console. Mounted at /api/control (owner session + CSRF like every /api route).
//
//   GET  /overview                     one line of real state per section
//   GET  /review?status=&kind=&source_id=&origin=&limit=&cursor=   Review Queue across all kinds + counts
//   GET  /review/:id                   original location + structured data + specific reason + allowed actions
//   POST /review/:id/resolve           {action: accept|correct|reject|dismiss, text?, lecture_kind?, note?}
//   GET  /processing                   jobs (stage, real counts, reasons) + versions with incomplete coverage
//   GET  /intelligence                 AI status per task/model, budget, usage per month/task/model (ESTIMATED)
//   POST /impact/preview               {change} → what would stop being reused; nothing is applied
//   POST /impact/apply                 {change, confirm_token} → applied only with a fresh preview token
//   GET  /sources                      per-task source priority + each source's priority / selection reason
//   GET  /storage                      data directory usage by category (measured)
//   GET  /history?entity_type=&entity_id=&limit=&before=   audit log in words
//
// Retry / cancel of jobs: /api/jobs/:id/retry|cancel. Page re-processing: /api/sources/versions/:id/reprocess.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IMPACT_SETTING_KEYS,
  LECTURE_KINDS,
  MODEL_ROLES,
  REVIEW_ACTIONS,
  REVIEW_QUEUE_KINDS,
  type ControlOverviewResponse,
  type ImpactApplyResponse,
  type ImpactChange,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { pruneOrphanHistory } from './corrections';
import { history } from './history';
import { applyImpact, previewImpact } from './impact';
import { intelligence } from './intelligence';
import { processingOverview } from './processing';
import { counts, listReview, resolveReview, reviewDetail } from './review';
import { sourcesPriorities } from './sources';
import { storageReport } from './storage';

const ID = z.string().min(1).max(64).regex(/^[0-9A-Za-z_-]+$/);

const reviewListQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  kind: z.enum(REVIEW_QUEUE_KINDS).optional(),
  source_id: ID.optional(),
  origin: z.string().min(1).max(32).regex(/^[a-z_]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(100).optional(),
});

const resolveBody = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    text: z.string().max(25_000).optional(),
    lecture_kind: z.enum(LECTURE_KINDS).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

const rulesPatch = z.record(z.string(), z.unknown());
const settingsPatch = z
  .object(Object.fromEntries(IMPACT_SETTING_KEYS.map((k) => [k, z.unknown().optional()])) as Record<(typeof IMPACT_SETTING_KEYS)[number], z.ZodOptional<z.ZodUnknown>>)
  .strict();
const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settings'), patch: settingsPatch }).strict(),
  z.object({ kind: z.literal('rules_owner'), patch: rulesPatch }).strict(),
  z.object({ kind: z.literal('rules_node'), node_id: ID, patch: rulesPatch.nullable() }).strict(),
  z
    .object({
      kind: z.literal('model'),
      role: z.enum(MODEL_ROLES),
      model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:@/-]+$/, 'اسم النموذج يحتوي على رموز غير مسموحة.'),
    })
    .strict(),
]);
const previewBody = z.object({ change: changeSchema }).strict();
const applyBody = z.object({ change: changeSchema, confirm_token: z.string().min(8).max(128) }).strict();

const historyQuery = z.object({
  entity_type: z.string().min(1).max(64).optional(),
  entity_id: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().min(1).max(64).optional(),
});

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  // a permanent delete of a source must not leave its text in the correction history
  try {
    pruneOrphanHistory(ctx);
  } catch (e) {
    ctx.log.warn({ err: e }, 'control: pruning correction history failed');
  }

  app.get('/overview', async (): Promise<ControlOverviewResponse> => {
    const c = counts(ctx);
    const alerts = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_alert WHERE status = 'open'`)!.n;
    const active = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM processing_job WHERE status IN ('queued','running','waiting_for_input')`)!.n;
    const failed = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM processing_job WHERE status = 'failed' AND COALESCE(finished_at, created_at) >= ?`, [ctx.clock.now() - 30 * 24 * 3600 * 1000])!.n;
    const attention = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM source_version v JOIN source s ON s.id = v.source_id WHERE s.deleted_at IS NULL AND v.processing_status IN ('partial','failed','needs_review')`,
    )!.n;
    const st = ctx.ai.status();
    return {
      review: { open: c.open, open_by_kind: c.open_by_kind },
      alerts: { open: alerts },
      processing: { active, failed, attention },
      ai: { configured: st.configured, provider: st.provider ?? null, spent_usd: st.budget.spent_usd, monthly_usd: st.budget.monthly_usd, estimated: true },
      generated_at: ctx.clock.now(),
    };
  });

  app.get('/review', async (req) => {
    pruneOrphanHistory(ctx);
    return listReview(ctx, parseQuery(reviewListQuery, req));
  });
  app.get('/review/:id', async (req) => reviewDetail(ctx, parseParams(z.object({ id: ID }), req).id));
  app.post('/review/:id/resolve', async (req) => resolveReview(ctx, parseParams(z.object({ id: ID }), req).id, parseBody(resolveBody, req)));

  app.get('/processing', async () => processingOverview(ctx));
  app.get('/intelligence', async () => intelligence(ctx));

  app.post('/impact/preview', async (req) => previewImpact(ctx, parseBody(previewBody, req).change as ImpactChange));
  app.post('/impact/apply', async (req): Promise<ImpactApplyResponse> => {
    const b = parseBody(applyBody, req);
    // rules overrides are written by their owning module (studybook) through its own route, in-process,
    // with the owner's session — this module never writes another module's table
    const forward = async (method: 'PUT' | 'DELETE', url: string, payload?: unknown) => {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: req.headers.cookie ?? '', 'x-medlevo-csrf': '1', 'user-agent': 'medlevo-control-forward', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      });
      return { statusCode: res.statusCode, body: res.body };
    };
    const r = await applyImpact(ctx, b.change as ImpactChange, b.confirm_token, forward);
    return { applied: true, effects_ar: r.effects_ar, preview: r.preview };
  });

  app.get('/sources', async () => sourcesPriorities(ctx));
  app.get('/storage', async () => storageReport(ctx));
  app.get('/history', async (req) => history(ctx, parseQuery(historyQuery, req)));
}
