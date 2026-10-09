// Sources module (§06, §07, §13 upload, §18, §49): /api/sources
//   GET    /upload-info                  limits & what can be processed right now
//   POST   /upload                       multipart: node_id (required), source_type?, title?, on_duplicate?=create; files…
//   GET    /?node_id=                    sources in a folder
//   GET    /:id                          SourceDetail (versions + parsed processing summary, links, breadcrumb)
//   PATCH  /:id                          metadata (never invented), type (origin owner), move, lecture kind (origin owner)…
//   POST   /:id/move {node_id, before_id?|after_id?}
//   POST   /:id/open                     last_opened_at
//   POST   /:id/freeze {version_id|null} Source Freeze
//   POST   /:id/versions                 multipart replacement → new version, processing, content alert
//   POST   /:id/links · DELETE /:id/links/:linkId
//   POST   /:id/archive | /unarchive | /trash | /restore {node_id?}
//   GET    /:id/impact?mode=purge|trash · DELETE /:id?confirm_token=…
//   GET    /:id/versions/:versionId/pages → SourcePagesResponse
//   GET    /pages/:pageId/regions         → PageRegionsResponse
//   POST   /versions/:versionId/reprocess {page_indexes?}
//   GET    /versions/:versionId/processing → {summary, job}
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LECTURE_KINDS,
  SOURCE_TYPES,
  type ImpactReport,
  type PageRegionsResponse,
  type ProcessingStatusResponse,
  type ReprocessResponse,
  type SourceDetail,
  type SourcePagesResponse,
  type SourceSummary,
  type UploadFileResult,
  type UploadInfoResponse,
  type UploadResponse,
} from '@medlevo/shared';
import type { ModuleOptions, AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { randomToken } from '../../lib/hash';
import { parseBody, parseParams, parseQuery, parseWith } from '../../lib/http';
import { buildImpactReport, executePurge, type ImpactCounts } from './purge';
import { getSourceRow, SourcesService } from './service';
import { cleanFileName } from './sniff';
import { enqueuePendingVersions, type IncomingFile, processingRegistered, registerReplacement, registerUpload, sofficeAvailable } from './upload';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));

const patchBody = z
  .object({
    title: z.string().trim().min(1, 'العنوان مطلوب.').max(300).optional(),
    source_type: z.enum(SOURCE_TYPES).optional(),
    node_id: id.optional(),
    language: z.enum(['ar', 'en', 'mixed']).nullable().optional(),
    edition: optText(120),
    authors: z.array(z.string().trim().min(1).max(200)).max(50).nullable().optional(),
    publication_date: z
      .string()
      .trim()
      .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'استخدم الصيغة YYYY أو YYYY-MM أو YYYY-MM-DD.')
      .nullable()
      .optional()
      .or(z.literal('').transform(() => null)),
    original_url: z
      .string()
      .trim()
      .max(2000)
      .refine((u) => {
        try {
          const p = new URL(u).protocol;
          return p === 'https:' || p === 'http:';
        } catch {
          return false;
        }
      }, 'أدخل رابطًا صحيحًا يبدأ بـ https:// أو http://')
      .nullable()
      .optional()
      .or(z.literal('').transform(() => null)),
    lecture_kind: z.enum(LECTURE_KINDS).nullable().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    selection_reason: optText(1000),
    metadata_status: z.enum(['unknown', 'partial', 'owner_confirmed']).optional(),
    is_favorite: z.boolean().optional(),
  })
  .strict();
const moveBody = z.object({ node_id: id, before_id: id.optional(), after_id: id.optional() }).strict();
const freezeBody = z.object({ version_id: id.nullable() }).strict();
const linkBody = z.object({ to_source_id: id, relation: z.enum(['reference_for', 'question_source_for', 'audio_for', 'same_topic']) }).strict();
const restoreBody = z.object({ node_id: id.optional() }).strict();
const impactQuery = z.object({ mode: z.enum(['purge', 'trash']).default('purge') });
const purgeQuery = z.object({ confirm_token: z.string().max(1024).optional() });
const reprocessBody = z.object({ page_indexes: z.array(z.number().int().min(0).max(100_000)).max(5000).optional() }).strict();
const listQuery = z.object({ node_id: id });
const uploadFields = z.object({
  node_id: id,
  source_type: z.enum(SOURCE_TYPES).optional(),
  title: z.string().trim().max(300).optional(),
  on_duplicate: z.enum(['report', 'create']).default('report'),
});
const replaceFields = z.object({ note: z.string().trim().max(1000).optional() });
/** The web sends ONE file per request (real per-file progress), so a large batch needs more than the
 *  generic upload preset (60/min). Still bounded; single owner, authenticated. */
const UPLOAD_RATE_LIMIT = { max: 300, timeWindow: 60_000 } as const;

interface ReadMultipart {
  fields: Record<string, string>;
  files: IncomingFile[];
  cleanup: () => void;
}

/** Stream every file part to a private temp file (never buffered whole in memory); collect fields. */
async function readMultipart(ctx: AppContext, req: FastifyRequest): Promise<ReadMultipart> {
  if (!req.isMultipart()) throw new AppError('UNSUPPORTED_FORMAT', 'يجب إرسال الملفات بصيغة multipart/form-data.', 415);
  const fields: Record<string, string> = {};
  const files: IncomingFile[] = [];
  const cleanup = () => {
    for (const f of files) rmSync(f.tmpPath, { force: true });
  };
  try {
    // per-file size limit: an oversized file is reported as rejected; the rest of the upload continues
    const parts = req.parts({ throwFileSizeLimit: false } as Parameters<FastifyRequest['parts']>[0]);
    for await (const part of parts) {
      if (part.type === 'file') {
        const tmpPath = join(ctx.config.tmpDir, `upload-${randomToken(12)}`);
        const entry: IncomingFile = { tmpPath, fileName: cleanFileName(part.filename), size: 0, truncated: false };
        files.push(entry);
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            entry.size += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(part.file, meter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
        entry.truncated = part.file.truncated === true;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { fields, files, cleanup };
}

export default async function sourcesModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('upload', 'available');
  if (sofficeAvailable()) ctx.capabilities.set('processing.legacy_office', 'available');
  else {
    ctx.capabilities.set(
      'processing.legacy_office',
      'requires_configuration',
      'ملفات Word وPowerPoint القديمة (.doc/.ppt) تحتاج تثبيت LibreOffice على الخادم لتحويلها. احفظها بصيغة DOCX/PPTX أو PDF.',
    );
  }
  const svc = new SourcesService(ctx);

  // Versions uploaded while no processing handler existed (or whose enqueue failed) are queued once one does.
  app.addHook('onReady', async () => {
    enqueuePendingVersions(ctx);
  });

  app.post('/upload', { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (req): Promise<UploadResponse> => {
    const mp = await readMultipart(ctx, req);
    try {
      const f = parseWith(uploadFields, mp.fields, 'body');
      if (mp.files.length === 0) throw new AppError('BAD_REQUEST', 'لم يُرفق أي ملف. اختر ملفًا واحدًا أو أكثر ثم أعد المحاولة.', 400);
      const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [f.node_id]);
      if (!node) throw new AppError('NOT_FOUND', 'المجلد الهدف غير موجود.', 404);
      if (node.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد الهدف في سلة المحذوفات. اختر مجلدًا آخر.', 409);
      const results: UploadFileResult[] = [];
      for (const file of mp.files) {
        try {
          results.push(
            await registerUpload(ctx, file, {
              nodeId: f.node_id,
              sourceType: f.source_type,
              title: mp.files.length === 1 ? f.title : undefined,
              onDuplicate: f.on_duplicate,
            }),
          );
        } catch (e) {
          req.log.error({ err: e }, 'upload of one file failed');
          const status = e instanceof AppError ? e.messageAr : 'تعذّر حفظ هذا الملف بسبب خطأ داخلي. أعد المحاولة.';
          results.push({ file_name: file.fileName, status: 'rejected', size: file.size, reason_ar: status });
        }
      }
      return { results };
    } finally {
      mp.cleanup();
    }
  });

  app.get('/upload-info', async (): Promise<UploadInfoResponse> => ({
    max_upload_bytes: ctx.config.limits.maxUploadBytes,
    max_zip_entries: ctx.config.limits.maxZipEntries,
    legacy_office: sofficeAvailable(),
    processing_available: processingRegistered(ctx),
  }));

  app.get('/', async (req): Promise<{ sources: SourceSummary[] }> => ({ sources: svc.inNode(parseQuery(listQuery, req).node_id) }));

  app.get('/pages/:id/regions', async (req): Promise<PageRegionsResponse> => svc.regions(parseParams(idParams, req).id));

  app.post('/versions/:id/reprocess', async (req): Promise<ReprocessResponse> => {
    const { id: versionId } = parseParams(idParams, req);
    const b = parseBody(reprocessBody, req);
    return { job: svc.reprocess(versionId, b.page_indexes) };
  });

  app.get('/versions/:id/processing', async (req): Promise<ProcessingStatusResponse> => svc.processing(parseParams(idParams, req).id));

  app.get('/:id', async (req): Promise<SourceDetail> => svc.detail(parseParams(idParams, req).id));

  app.get('/:id/versions/:versionId/pages', async (req): Promise<SourcePagesResponse> => {
    const p = parseParams(z.object({ id, versionId: id }), req);
    return svc.pages(p.id, p.versionId);
  });

  app.patch('/:id', async (req): Promise<SourceDetail> => {
    const { id: sourceId } = parseParams(idParams, req);
    return svc.patch(sourceId, parseBody(patchBody, req));
  });

  app.post('/:id/move', async (req): Promise<{ source: SourceSummary }> => {
    const { id: sourceId } = parseParams(idParams, req);
    return { source: svc.move(sourceId, parseBody(moveBody, req)) };
  });

  app.post('/:id/open', async (req): Promise<{ source: SourceSummary }> => ({ source: svc.markOpened(parseParams(idParams, req).id) }));

  app.post('/:id/freeze', async (req): Promise<SourceDetail> => {
    const { id: sourceId } = parseParams(idParams, req);
    return svc.freeze(sourceId, parseBody(freezeBody, req).version_id);
  });

  app.post('/:id/versions', { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (req): Promise<UploadResponse> => {
    const { id: sourceId } = parseParams(idParams, req);
    const src = getSourceRow(ctx, sourceId);
    if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا.', 409);
    const mp = await readMultipart(ctx, req);
    try {
      const f = parseWith(replaceFields, mp.fields, 'body');
      if (mp.files.length !== 1) throw new AppError('BAD_REQUEST', 'أرفق ملفًا واحدًا للنسخة الجديدة.', 400);
      return { results: [await registerReplacement(ctx, sourceId, mp.files[0]!, f.note ?? null)] };
    } finally {
      mp.cleanup();
    }
  });

  app.post('/:id/links', async (req) => {
    const { id: sourceId } = parseParams(idParams, req);
    const b = parseBody(linkBody, req);
    return { link: svc.addLink(sourceId, b.to_source_id, b.relation) };
  });

  app.delete('/:id/links/:linkId', async (req) => {
    const p = parseParams(z.object({ id, linkId: id }), req);
    svc.removeLink(p.id, p.linkId);
    return { ok: true };
  });

  app.post('/:id/archive', async (req): Promise<{ source: SourceSummary }> => ({ source: svc.setArchived(parseParams(idParams, req).id, true) }));
  app.post('/:id/unarchive', async (req): Promise<{ source: SourceSummary }> => ({ source: svc.setArchived(parseParams(idParams, req).id, false) }));
  app.post('/:id/trash', async (req): Promise<{ source: SourceSummary }> => ({ source: svc.trash(parseParams(idParams, req).id) }));
  app.post('/:id/restore', async (req): Promise<{ source: SourceSummary }> => {
    const { id: sourceId } = parseParams(idParams, req);
    return { source: svc.restore(sourceId, parseBody(restoreBody, req)) };
  });

  app.get('/:id/impact', async (req): Promise<ImpactReport> => {
    const { id: sourceId } = parseParams(idParams, req);
    const { mode } = parseQuery(impactQuery, req);
    getSourceRow(ctx, sourceId);
    return buildImpactReport(ctx, 'source', sourceId, { sourceIds: [sourceId] }, mode);
  });

  app.delete('/:id', async (req): Promise<{ ok: true; removed: ImpactCounts; removed_files: number }> => {
    const { id: sourceId } = parseParams(idParams, req);
    const { confirm_token } = parseQuery(purgeQuery, req);
    const src = getSourceRow(ctx, sourceId);
    if (src.deleted_at === null) {
      throw new AppError('CONFLICT', 'الحذف النهائي متاح فقط من سلة المحذوفات. انقل المصدر إلى السلة أولًا.', 409, { reason: 'not_in_trash' });
    }
    const r = executePurge(ctx, 'source', sourceId, { sourceIds: [sourceId] }, confirm_token, {
      summary: `«${src.title}»`,
      before: { title: src.title, source_type: src.source_type, node_id: src.node_id },
    });
    return { ok: true, removed: r.counts, removed_files: r.removedFiles };
  });
}
