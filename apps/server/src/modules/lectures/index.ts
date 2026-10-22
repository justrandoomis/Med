// Official lectures in subject spaces (Academic OS track P1-T5 step 1; BUILD_PLAN §3.7; ARCHITECTURE_DELTA §5.5, §7.4).
// Mounted under /api/spaces: every route below is on the space-route allow-list (authz/spaceRoutes.ts) with its
// minimum access in THAT subject, so the binding hook has already bound the subject's space for a viewer with that
// access (gate 2) — everyone else got «not found». Each handler then asserts its own authz decision (gate 3,
// rules/lectures.ts) and resolves the ids it is given inside this space only.
//
//   lectures   GET · POST /lectures · POST /lectures/from-vault (step 2) · GET · PATCH /lectures/:id · POST …/upload (multipart, one file) · …/approve ·
//              …/versions/:v/publish {preview?} · GET …/versions/:a/compare/:b · POST …/page-map/decisions ·
//              …/withdraw · …/corrections · …/corrections/:c/decide · GET …/offline-package
//   subject    GET · POST /subject/attachments · PATCH …/:id · GET /subject/exam-dates · PUT · DELETE …/:id ·
//              GET /subject/events · GET /subject/corrections · GET /subject/duplicates
//   re-mounted GET /sources/:id · …/versions/:v/pages · /sources/pages/:id/regions · /sources/versions/:id/processing ·
//              POST /sources/versions/:id/reprocess · GET /versions/pages/:id/thumbnail · /versions/versions/:id/toc ·
//              …/files · GET /files/:id · /files/:id/meta
//   publications (P1-T5 step 3, forks/publications.ts) POST /publications · POST …/:id/versions · PATCH · POST …/withdraw ·
//              GET /publications/:id · …/versions/:n/items · …/diff · GET /lectures/:id/publications
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  approveOfficialLectureSchema,
  createOfficialLectureSchema,
  createSubjectAttachmentFieldsSchema,
  createSubjectAttachmentSchema,
  decideOfficialCorrectionSchema,
  lectureFromVaultSchema,
  officialCorrectionSchema,
  officialCorrectionsQuerySchema,
  officialLecturesQuerySchema,
  officialPageMapDecisionsSchema,
  patchOfficialLectureSchema,
  patchSubjectAttachmentSchema,
  publishOfficialVersionSchema,
  putSubjectExamDateSchema,
  subjectEventsQuerySchema,
  uploadOfficialVersionSchema,
  withdrawOfficialLectureSchema,
  type StoredFileView,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { randomToken } from '../../lib/hash';
import { parseBody, parseParams, parseQuery, parseWith } from '../../lib/http';
import { registerLectureRules } from '../authz/rules/lectures';
import { enqueueOfficialFanout } from '../forks/fanout';
import { registerPublicationRoutes } from '../forks/publications';
import { promoteFromVault } from '../forks/promote';
import { sendStoredFile } from '../files';
import { toFileView } from '../files/store';
import { detectTools, renderPdfPage } from '../processing/tools';
import { createLimiter } from '../versions/limit';
import { getPageMap } from '../versions/pagemap';
import { CorrectionsService, OFFICIAL_CORRECTION_JOB } from './corrections';
import { readOneFile } from './ingest';
import { buildOfficialPackage } from './offline';
import { SpaceReads } from './reads';
import { LecturesService, OFFICIAL_PAGE_MAP_JOB, pageMapStatus } from './service';
import { scopeOf } from './store';
import { SubjectService } from './subject';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const lectureParams = z.object({ spaceId: id, lectureId: id });
const versionParams = lectureParams.extend({ versionId: id });
const compareParams = versionParams.extend({ toVersionId: id });
const correctionParams = lectureParams.extend({ correctionId: id });
const attachmentParams = z.object({ spaceId: id, attachmentId: id });
const examParams = z.object({ spaceId: id, examDateId: id });
const idParams = z.object({ spaceId: id, id });
const sourceVersionParams = z.object({ spaceId: id, id, versionId: id });
const reprocessBody = z.object({ page_indexes: z.array(z.number().int().min(0).max(100_000)).max(5000).optional() }).strict();

/** One file per request (the web client sends one per request for real per-file progress), so batches need room. */
const UPLOAD_RATE = { max: 300, timeWindow: 60_000 } as const;

/**
 * The official offline package reads the space's own routes in-process (one per page), and those requests all come from
 * 127.0.0.1: counted per address they would share ONE bucket across every student downloading before an exam (review
 * R6). They carry a per-process secret header instead and skip the read limit; the package route itself stays limited
 * per client, and a client that sends the header without the secret is limited as usual.
 */
const FORWARD_HEADER = 'x-medlevo-forward';

/** A space file is revalidated on every use (ETag → 304), so a takedown or a removed membership takes effect at once (R7). */
const SPACE_FILE_CACHE = 'private, no-cache';

const NO_SPACE_UPLOAD_AR = 'جلسة الرفع غير موجودة في هذه المادة. أرسل الملف مع الطلب نفسه (multipart).';

export default async function lecturesModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  registerLectureRules(ctx.authz);
  const forwardSecret = Buffer.from(randomToken(24));
  const isForward = (req: FastifyRequest): boolean => {
    const v = req.headers[FORWARD_HEADER];
    if (typeof v !== 'string') return false;
    const got = Buffer.from(v);
    return got.length === forwardSecret.length && timingSafeEqual(got, forwardSecret);
  };
  const READ_RATE = { max: 600, timeWindow: 60_000, allowList: (req: FastifyRequest) => isForward(req) };
  const lectures = new LecturesService(ctx);
  const corrections = new CorrectionsService(ctx, lectures);
  const subject = new SubjectService(ctx);
  const reads = new SpaceReads(ctx);

  ctx.jobs.register<{ lecture_id: string; from: string; to: string }, unknown>(OFFICIAL_PAGE_MAP_JOB, {
    version: '1',
    maxAttempts: 3,
    timeoutMs: 30 * 60 * 1000,
    inputSchema: z.object({ lecture_id: id, from: id, to: id }).strict() as unknown as z.ZodType<{ lecture_id: string; from: string; to: string }>,
    handler: async (run) => {
      try {
        const map = await getPageMap(ctx, run.input.from, run.input.to, { signal: run.signal });
        pageMapStatus(ctx, run.input.to, 'ready');
        // P1-T5 step 2: the new version reaches the copy holders with this map (their note copy uses it)
        enqueueOfficialFanout(ctx, { lecture_id: run.input.lecture_id, version_id: run.input.to, reason: 'published' });
        return { counts: map.counts };
      } catch (e) {
        if (run.attempt >= 3) {
          pageMapStatus(ctx, run.input.to, 'failed');
          // the holders still get the version; their vault computes its own map from the page fingerprints
          enqueueOfficialFanout(ctx, { lecture_id: run.input.lecture_id, version_id: run.input.to, reason: 'published' });
        }
        throw e;
      }
    },
  });
  ctx.jobs.register<{ correction_id: string }, unknown>(OFFICIAL_CORRECTION_JOB, {
    version: '1',
    maxAttempts: 3,
    timeoutMs: 30 * 60 * 1000,
    inputSchema: z.object({ correction_id: id }).strict() as unknown as z.ZodType<{ correction_id: string }>,
    handler: async (run) => corrections.runJob(run.input.correction_id),
  });

  const isMultipart = (req: FastifyRequest) => req.isMultipart();

  // P1-T5 step 3: course-only publications of this subject (/publications…, /lectures/:id/publications) — the forks
  // module's handlers, mounted here because every /api/spaces route lives under this plugin's prefix
  registerPublicationRoutes(app, ctx);

  // ───────── official lectures ─────────

  app.get('/:spaceId/lectures', async (req) => lectures.list(scopeOf(ctx), parseQuery(officialLecturesQuerySchema, req)));

  app.post('/:spaceId/lectures', async (req) => lectures.create(scopeOf(ctx), parseBody(createOfficialLectureSchema, req)));

  // «انشر كمحاضرة رسمية» (P1-T5 step 2, AOS-19H.4): a moderator promotes a private source of their OWN vault
  app.post('/:spaceId/lectures/from-vault', { config: { rateLimit: UPLOAD_RATE } }, async (req) => promoteFromVault(ctx, scopeOf(ctx), parseBody(lectureFromVaultSchema, req), lectures));

  app.get('/:spaceId/lectures/:lectureId', async (req) => lectures.detail(scopeOf(ctx), parseParams(lectureParams, req).lectureId));

  app.patch('/:spaceId/lectures/:lectureId', async (req) => lectures.patch(scopeOf(ctx), parseParams(lectureParams, req).lectureId, parseBody(patchOfficialLectureSchema, req)));

  app.post('/:spaceId/lectures/:lectureId/upload', { config: { rateLimit: UPLOAD_RATE } }, async (req) => {
    const scope = scopeOf(ctx);
    const { lectureId } = parseParams(lectureParams, req);
    if (!isMultipart(req)) {
      parseBody(uploadOfficialVersionSchema, req);
      // the lecture's rules first: a stranger learns nothing; then the upload id, which no resumable upload targets yet
      lectures.detail(scope, lectureId);
      throw new AppError('NOT_FOUND', NO_SPACE_UPLOAD_AR, 404);
    }
    // ask BEFORE reading the body: a member who may not upload here never makes the server store a byte (review R10)
    lectures.assertCanUpload(scope, lectureId);
    const mp = await readOneFile(ctx, req);
    try {
      if (!mp.file) throw new AppError('BAD_REQUEST', 'أرفق ملف المحاضرة مع الطلب (ملف واحد).', 400);
      return await lectures.upload(scope, lectureId, mp.file);
    } finally {
      mp.cleanup();
    }
  });

  app.post('/:spaceId/lectures/:lectureId/approve', async (req) => {
    parseBody(approveOfficialLectureSchema, req);
    return lectures.approve(scopeOf(ctx), parseParams(lectureParams, req).lectureId);
  });

  app.post('/:spaceId/lectures/:lectureId/versions/:versionId/publish', async (req) => {
    const p = parseParams(versionParams, req);
    return lectures.publish(scopeOf(ctx), p.lectureId, p.versionId, parseBody(publishOfficialVersionSchema, req));
  });

  app.get('/:spaceId/lectures/:lectureId/versions/:versionId/compare/:toVersionId', async (req) => {
    const p = parseParams(compareParams, req);
    return lectures.compare(scopeOf(ctx), p.lectureId, p.versionId, p.toVersionId);
  });

  app.post('/:spaceId/lectures/:lectureId/page-map/decisions', async (req) =>
    lectures.pageMapDecisions(scopeOf(ctx), parseParams(lectureParams, req).lectureId, parseBody(officialPageMapDecisionsSchema, req)),
  );

  app.post('/:spaceId/lectures/:lectureId/withdraw', async (req) => lectures.withdraw(scopeOf(ctx), parseParams(lectureParams, req).lectureId, parseBody(withdrawOfficialLectureSchema, req)));

  app.post('/:spaceId/lectures/:lectureId/corrections', async (req) => corrections.request(scopeOf(ctx), parseParams(lectureParams, req).lectureId, parseBody(officialCorrectionSchema, req)));

  app.post('/:spaceId/lectures/:lectureId/corrections/:correctionId/decide', async (req) => {
    const p = parseParams(correctionParams, req);
    const b = parseBody(decideOfficialCorrectionSchema, req);
    return corrections.decide(scopeOf(ctx), p.lectureId, p.correctionId, b.decision, b.note_ar ?? null);
  });

  app.get('/:spaceId/lectures/:lectureId/offline-package', { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (req) => {
    const scope = scopeOf(ctx);
    const headers: Record<string, string> = { cookie: req.headers.cookie ?? '', 'user-agent': 'medlevo-lectures-forward', [FORWARD_HEADER]: forwardSecret.toString() };
    return buildOfficialPackage(ctx, scope, parseParams(lectureParams, req).lectureId, async (path) => {
      const res = await app.inject({ method: 'GET', url: path, headers });
      return { status: res.statusCode, body: res.body };
    });
  });

  // ───────── the subject's content ─────────

  app.get('/:spaceId/subject/attachments', async () => ({ attachments: subject.listAttachments(scopeOf(ctx)) }));

  app.post('/:spaceId/subject/attachments', { config: { rateLimit: UPLOAD_RATE } }, async (req) => {
    const scope = scopeOf(ctx);
    if (!isMultipart(req)) {
      parseBody(createSubjectAttachmentSchema, req);
      ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId });
      throw new AppError('NOT_FOUND', NO_SPACE_UPLOAD_AR, 404);
    }
    ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId }); // before the body is read (R10)
    const mp = await readOneFile(ctx, req);
    try {
      const fields = parseWith(createSubjectAttachmentFieldsSchema, mp.fields, 'body');
      return await subject.createAttachment(scope, fields, mp.file);
    } finally {
      mp.cleanup();
    }
  });

  app.patch('/:spaceId/subject/attachments/:attachmentId', async (req) =>
    subject.patchAttachment(scopeOf(ctx), parseParams(attachmentParams, req).attachmentId, parseBody(patchSubjectAttachmentSchema, req).status),
  );

  app.get('/:spaceId/subject/exam-dates', async () => ({ exam_dates: subject.listExamDates(scopeOf(ctx)) }));

  app.put('/:spaceId/subject/exam-dates/:examDateId', async (req) => subject.putExamDate(scopeOf(ctx), parseParams(examParams, req).examDateId, parseBody(putSubjectExamDateSchema, req)));

  app.delete('/:spaceId/subject/exam-dates/:examDateId', async (req) => subject.cancelExamDate(scopeOf(ctx), parseParams(examParams, req).examDateId));

  app.get('/:spaceId/subject/events', async (req) => subject.events(scopeOf(ctx), parseQuery(subjectEventsQuerySchema, req)));

  app.get('/:spaceId/subject/corrections', async (req) => ({ corrections: corrections.list(scopeOf(ctx), parseQuery(officialCorrectionsQuerySchema, req)) }));

  app.get('/:spaceId/subject/duplicates', async () => subject.duplicates(scopeOf(ctx)));

  // ───────── existing read routes, re-mounted for official content ─────────

  app.get('/:spaceId/sources/:id', async (req) => reads.sourceDetail(scopeOf(ctx), parseParams(idParams, req).id));

  app.get('/:spaceId/sources/:id/versions/:versionId/pages', async (req) => {
    const p = parseParams(sourceVersionParams, req);
    return reads.pages(scopeOf(ctx), p.id, p.versionId);
  });

  app.get('/:spaceId/sources/pages/:id/regions', { config: { rateLimit: READ_RATE } }, async (req) => reads.regions(scopeOf(ctx), parseParams(idParams, req).id));

  app.get('/:spaceId/sources/versions/:id/processing', async (req) => reads.processing(scopeOf(ctx), parseParams(idParams, req).id));

  app.post('/:spaceId/sources/versions/:id/reprocess', async (req) => reads.reprocess(scopeOf(ctx), parseParams(idParams, req).id, parseBody(reprocessBody, req).page_indexes));

  const thumbnails = createLimiter(3);
  app.get('/:spaceId/versions/pages/:id/thumbnail', { config: { rateLimit: READ_RATE } }, async (req, reply) => {
    const scope = scopeOf(ctx);
    const p = reads.thumbnailPage(scope, parseParams(idParams, req).id);
    if (p.render_file_id && ctx.files.stat(p.render_file_id)) return reply.redirect(`/api/spaces/${encodeURIComponent(scope.spaceId)}/files/${encodeURIComponent(p.render_file_id)}`, 302);
    const pdfId = p.display_file_id ?? (p.format === 'pdf' ? p.file_id : null);
    const pdftoppm = detectTools().pdftoppm;
    if (!pdfId || !ctx.files.stat(pdfId) || !(p.kind === 'page' || p.kind === 'slide')) throw new AppError('NOT_FOUND', 'لا توجد صورة لهذه الصفحة (المستند يُعرض كفقرات).', 404);
    if (!pdftoppm) throw new AppError('FEATURE_DISABLED', 'عرض صور الصفحات يحتاج أداة poppler (pdftoppm) على الخادم.', 409);
    const png = await thumbnails.run(() => renderPdfPage({ pdftoppm, pdfPath: ctx.files.path(pdfId), pageNumber: p.page_index + 1, dpi: 36, tmpRoot: ctx.config.tmpDir, timeoutMs: 30_000 }));
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(png);
  });

  app.get('/:spaceId/versions/versions/:id/toc', async (req) => reads.toc(scopeOf(ctx), parseParams(idParams, req).id));

  app.get('/:spaceId/versions/versions/:id/files', async (req) => reads.files(scopeOf(ctx), parseParams(idParams, req).id));

  const revalidate = async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('cache-control', SPACE_FILE_CACHE);
    return payload;
  };

  app.get('/:spaceId/files/:id/meta', async (req): Promise<StoredFileView> => {
    const fileId = parseParams(idParams, req).id;
    reads.fileVisible(scopeOf(ctx), fileId);
    const file = ctx.files.stat(fileId);
    if (!file) throw new AppError('NOT_FOUND', 'الملف غير موجود أو لم يعد متاحًا.', 404);
    return toFileView(file);
  });

  app.get('/:spaceId/files/:id', { config: { rateLimit: READ_RATE }, onSend: revalidate }, async (req, reply) => {
    const fileId = parseParams(idParams, req).id;
    reads.fileVisible(scopeOf(ctx), fileId);
    const file = ctx.files.stat(fileId);
    if (!file) throw new AppError('NOT_FOUND', 'الملف غير موجود أو لم يعد متاحًا.', 404);
    return sendStoredFile(ctx.files, file, req, reply);
  });
}

