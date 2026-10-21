// Versions module (Academic OS track P1-T3): lecture identity, page fingerprints, version page maps, compare, link
// candidates, printed contents, DOCX display PDFs. /api/versions
//   GET    /sources/:id/identity          → SourceIdentityResponse (number, date, origins, suggestions, analysis state)
//   PATCH  /sources/:id/identity          {lecture_no?, held_on?} → the owner's values (origin owner)
//   POST   /sources/:id/analyze           re-run the analysis of the current version (e.g. a lecture uploaded before)
//   GET    /sources/:id/link-candidates   → LinkCandidatesResponse (this database only)
//   GET    /suggestions?status=           → the uploader's review queue (open by default)
//   POST   /suggestions/:id/decide        {action: accept|reject} → DecideSuggestionResponse
//   GET    /compare?from=&to=             → VersionCompareResponse (side-by-side page map)
//   POST   /maps/decide                   {from_version_id, to_version_id, from_page_id, action, to_page_id?} → compare
//   GET    /versions/:id/toc              → PrintedTocView
//   GET    /versions/:id/files            → VersionFilesResponse (original vs converted)
//   POST   /versions/:id/docx-display     (re)make the DOCX display PDF
//   GET    /pages/:id/thumbnail           → PNG of one page (PDF pages rendered on demand; image pages served)
//   GET    /order?node_id=&mode=          → LectureOrderResponse;  POST /order/apply {node_id, mode}
// Background jobs: analyze_version (processing follow-up), docx_display_pdf, fingerprint_backfill, versions_release_files.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LECTURE_ORDER_MODES,
  type DecideSuggestionResponse,
  type ImportSuggestionListResponse,
  type LectureOrderResponse,
  type LinkCandidatesResponse,
  type PrintedTocView,
  type SourceIdentityResponse,
  type VersionCompareResponse,
  type VersionFilesResponse,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { DOCX_DISPLAY_JOB, FINGERPRINT_ALGO, VERSION_ANALYSIS_JOB } from '../processing/fingerprint';
import { detectTools, renderPdfPage } from '../processing/tools';
import { FINGERPRINT_BACKFILL_JOB, runFingerprintBackfill, runVersionAnalysis, versionsNeedingFingerprints } from './analysis';
import { LINK_THRESHOLD, linkCandidatesFor } from './candidates';
import { compareVersions, requestAnalysis } from './compare';
import { decideSuggestion, identityView, listSuggestions, updateIdentity } from './identity';
import { applyLectureOrder, lectureOrder } from './order';
import { createLimiter } from './limit';
import { decidePage } from './pagemap';
import { registerVersionsPurgeExtension, RELEASE_FILES_JOB, releaseFiles } from './purgeExtension';
import { makeDocxDisplayPdf, versionFiles } from './rendition';
import { printedToc } from './toc';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });
const versionInput = z.object({ version_id: id }).strict();
const identityBody = z
  .object({
    lecture_no: z.number().int().min(1, 'رقم المحاضرة من 1 إلى 999.').max(999, 'رقم المحاضرة من 1 إلى 999.').nullable().optional(),
    held_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'استخدم الصيغة YYYY-MM-DD.').nullable().optional(),
  })
  .strict()
  .refine((b) => b.lecture_no !== undefined || b.held_on !== undefined, 'لا يوجد ما يُحفظ.');
const listQuery = z.object({ status: z.enum(['open', 'applied', 'accepted', 'rejected', 'superseded', 'open_or_applied']).default('open') });
const decideBody = z.object({ action: z.enum(['accept', 'reject']) }).strict();
const compareQuery = z.object({ from: id, to: id });
const mapDecisionBody = z
  .object({ from_version_id: id, to_version_id: id, from_page_id: id, action: z.enum(['confirm', 'reject', 'reset']), to_page_id: id.optional() })
  .strict();
const orderQuery = z.object({ node_id: id, mode: z.enum(LECTURE_ORDER_MODES).default('number') });
const orderBody = z.object({ node_id: id, mode: z.enum(LECTURE_ORDER_MODES) }).strict();
const releaseInput = z.object({ file_ids: z.array(id).max(10_000) }).strict();

export default async function versionsModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.jobs.register<{ version_id: string }, unknown>(VERSION_ANALYSIS_JOB, {
    version: `analysis-1|${FINGERPRINT_ALGO}`,
    maxAttempts: 2,
    timeoutMs: 20 * 60 * 1000,
    concurrency: 1,
    inputSchema: versionInput as unknown as z.ZodType<{ version_id: string }>,
    handler: async (run) => runVersionAnalysis(ctx, run.input.version_id, { id: run.id, signal: run.signal, progress: (p) => run.progress(p) }),
  });
  ctx.jobs.register<{ version_id: string }, unknown>(DOCX_DISPLAY_JOB, {
    version: 'docx-display-1',
    maxAttempts: 2,
    timeoutMs: 10 * 60 * 1000,
    concurrency: 1,
    inputSchema: versionInput as unknown as z.ZodType<{ version_id: string }>,
    handler: async (run) => {
      run.progress({ stage: 'convert' });
      return makeDocxDisplayPdf(ctx, run.input.version_id, run.signal);
    },
  });
  ctx.jobs.register<Record<string, never>, unknown>(FINGERPRINT_BACKFILL_JOB, {
    version: FINGERPRINT_ALGO,
    maxAttempts: 2,
    timeoutMs: 6 * 60 * 60 * 1000,
    concurrency: 1,
    handler: async (run) => runFingerprintBackfill(ctx, { signal: run.signal, progress: (p) => run.progress(p) }),
  });
  ctx.jobs.register<{ file_ids: string[] }, unknown>(RELEASE_FILES_JOB, {
    version: '1',
    maxAttempts: 3,
    timeoutMs: 10 * 60 * 1000,
    concurrency: 1,
    inputSchema: releaseInput as unknown as z.ZodType<{ file_ids: string[] }>,
    handler: async (run) => releaseFiles(ctx, run.input.file_ids),
  });
  registerVersionsPurgeExtension(ctx);

  // versions processed before fingerprints existed get them once, in the background (no suggestions are made for them)
  app.addHook('onReady', async () => {
    try {
      if (versionsNeedingFingerprints(ctx, 1).length > 0) {
        ctx.jobs.enqueue(FINGERPRINT_BACKFILL_JOB, {}, { idempotencyKey: `${FINGERPRINT_BACKFILL_JOB}:${FINGERPRINT_ALGO}:${new Date(ctx.clock.now()).toISOString().slice(0, 10)}` });
      }
    } catch (e) {
      ctx.log.warn({ err: e }, 'could not queue the fingerprint backfill');
    }
  });

  const sourceExists = (sourceId: string) => {
    if (!ctx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  };
  const studiedVersion = (sourceId: string) =>
    ctx.db.get<{ v: string | null }>('SELECT COALESCE(frozen_version_id, current_version_id) AS v FROM source WHERE id = ?', [sourceId])?.v ?? null;

  app.get('/sources/:id/identity', async (req): Promise<SourceIdentityResponse> => {
    const sourceId = parseParams(idParams, req).id;
    sourceExists(sourceId);
    const current = ctx.db.get<{ v: string | null }>('SELECT current_version_id AS v FROM source WHERE id = ?', [sourceId])?.v ?? null;
    let analysis: SourceIdentityResponse['analysis'] = null;
    if (current) {
      const job = ctx.db.get<{ id: string; status: string; error_detail: string | null }>(
        `SELECT id, status, error_detail FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [VERSION_ANALYSIS_JOB, current],
      );
      const state = !job ? 'not_run' : job.status === 'completed' || job.status === 'partial' ? 'ready' : job.status === 'failed' || job.status === 'cancelled' ? 'failed' : 'pending';
      analysis = { version_id: current, state, job_id: job?.id ?? null, reason_ar: state === 'failed' ? 'تعذّر تحليل هذه النسخة. يمكنك إعادة المحاولة.' : state === 'not_run' ? 'لم تُحلَّل هذه النسخة بعد (رُفعت قبل هذه الميزة أو لم تنتهِ معالجتها).' : null };
    }
    return { identity: identityView(ctx, sourceId), suggestions: listSuggestions(ctx, { sourceId }), analysis };
  });

  app.patch('/sources/:id/identity', async (req): Promise<SourceIdentityResponse['identity']> => {
    const sourceId = parseParams(idParams, req).id;
    return updateIdentity(ctx, sourceId, parseBody(identityBody, req));
  });

  app.post('/sources/:id/analyze', async (req): Promise<{ job_id: string | null }> => {
    const sourceId = parseParams(idParams, req).id;
    sourceExists(sourceId);
    const v = ctx.db.get<{ v: string | null }>('SELECT current_version_id AS v FROM source WHERE id = ?', [sourceId])?.v;
    if (!v) throw new AppError('CONFLICT', 'لا توجد نسخة لهذا المصدر بعد.', 409);
    return { job_id: requestAnalysis(ctx, v, 'owner') };
  });

  app.get('/sources/:id/link-candidates', async (req): Promise<LinkCandidatesResponse> => {
    const sourceId = parseParams(idParams, req).id;
    sourceExists(sourceId);
    const v = studiedVersion(sourceId);
    return { source_id: sourceId, candidates: v ? linkCandidatesFor(ctx, v) : [], threshold: LINK_THRESHOLD };
  });

  app.get('/suggestions', async (req): Promise<ImportSuggestionListResponse> => ({ suggestions: listSuggestions(ctx, { status: parseQuery(listQuery, req).status }) }));

  app.post('/suggestions/:id/decide', async (req): Promise<DecideSuggestionResponse> => {
    const sid = parseParams(idParams, req).id;
    return decideSuggestion(ctx, sid, parseBody(decideBody, req).action);
  });

  app.get('/compare', async (req): Promise<VersionCompareResponse> => {
    const q = parseQuery(compareQuery, req);
    return compareVersions(ctx, q.from, q.to);
  });

  app.post('/maps/decide', async (req): Promise<VersionCompareResponse> => {
    const b = parseBody(mapDecisionBody, req);
    decidePage(ctx, b.from_version_id, b.to_version_id, { from_page_id: b.from_page_id, action: b.action, ...(b.to_page_id ? { to_page_id: b.to_page_id } : {}) });
    return compareVersions(ctx, b.from_version_id, b.to_version_id);
  });

  app.get('/versions/:id/toc', async (req): Promise<PrintedTocView> => printedToc(ctx, parseParams(idParams, req).id));

  app.get('/versions/:id/files', async (req): Promise<VersionFilesResponse> => versionFiles(ctx, parseParams(idParams, req).id));

  app.post('/versions/:id/docx-display', async (req): Promise<VersionFilesResponse> => {
    const versionId = parseParams(idParams, req).id;
    const v = ctx.db.get<{ format: string }>('SELECT format FROM source_version WHERE id = ?', [versionId]);
    if (!v) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
    if (v.format !== 'docx') throw new AppError('BAD_REQUEST', 'نسخة العرض PDF تُنشأ هنا لمستندات Word (DOCX) فقط.', 400);
    if (!detectTools().soffice) throw new AppError('FEATURE_DISABLED', 'إنشاء نسخة عرض PDF يحتاج LibreOffice على الخادم، وهو غير مثبت.', 409);
    ctx.jobs.enqueue(DOCX_DISPLAY_JOB, { version_id: versionId }, { idempotencyKey: `${DOCX_DISPLAY_JOB}:${versionId}:owner:${ctx.clock.now()}` });
    return versionFiles(ctx, versionId);
  });

  // (review) at most 3 page renders at a time; the rest wait their turn (each render is a pdftoppm child process)
  const thumbnails = createLimiter(3);
  app.get('/pages/:id/thumbnail', { config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (req, reply) => {
    const pageId = parseParams(idParams, req).id;
    const p = ctx.db.get<{ page_index: number; kind: string; render_file_id: string | null; format: string; file_id: string | null; display_file_id: string | null }>(
      `SELECT p.page_index, p.kind, p.render_file_id, v.format, v.file_id, v.display_file_id FROM source_page p JOIN source_version v ON v.id = p.version_id WHERE p.id = ?`,
      [pageId],
    );
    if (!p) throw new AppError('NOT_FOUND', 'الصفحة غير موجودة.', 404);
    // an image page IS its picture: the stored file is served as is (never decoded on the request loop, NFR-OP2)
    if (p.render_file_id && ctx.files.stat(p.render_file_id)) return reply.redirect(`/api/files/${encodeURIComponent(p.render_file_id)}`, 302);
    const pdfId = p.display_file_id ?? (p.format === 'pdf' ? p.file_id : null);
    const pdftoppm = detectTools().pdftoppm;
    if (!pdfId || !ctx.files.stat(pdfId) || !(p.kind === 'page' || p.kind === 'slide')) throw new AppError('NOT_FOUND', 'لا توجد صورة لهذه الصفحة (المستند يُعرض كفقرات).', 404);
    if (!pdftoppm) throw new AppError('FEATURE_DISABLED', 'عرض صور الصفحات يحتاج أداة poppler (pdftoppm) على الخادم.', 409);
    // rendered by poppler in a child process (not on the event loop), small: the compare screen shows ~180 px wide
    const png = await thumbnails.run(() => renderPdfPage({ pdftoppm, pdfPath: ctx.files.path(pdfId), pageNumber: p.page_index + 1, dpi: 36, tmpRoot: ctx.config.tmpDir, timeoutMs: 30_000 }));
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(png);
  });

  app.get('/order', async (req): Promise<LectureOrderResponse> => {
    const q = parseQuery(orderQuery, req);
    return lectureOrder(ctx, q.node_id, q.mode);
  });

  app.post('/order/apply', async (req): Promise<LectureOrderResponse> => {
    const b = parseBody(orderBody, req);
    return applyLectureOrder(ctx, b.node_id, b.mode);
  });
}
