// Annotations module (/api/annotations) — track B1. Owns annotation, annotation_target, note, note_page,
// ink_recognition, study_session, source_progress (ARCHITECTURE §2).
//  * (track F4) handwriting recognition: /recognitions (create → job ink.recognize, list, read, correct, retry,
//    delete the derived reading, image) and /ask-context (handwriting + the paragraph next to it → a chat request)
//  * sync entity handlers: annotation, note, note_page, study_session (merge policies in ./sync.ts)
//  * read APIs for the reader, the ink engine, offline download and Continue Studying
//  * reading progress (pages shown) — Reading Progress only, never mastery (§45)
//  * (Academic OS P1-T2) authorship layers: /layers (list, create, rename / show / hide / lock), /layers/copy
//    («انسخ الطبقة», preview first), /layers/:id/history (read-only «سجل الطبقة»); sync entity `annotation_layer`;
//    layer rules R1–R6 in ./sync.ts + ./layers.ts; history in ./history.ts; purge of layers, revisions and attribution
//    through the purge-extension seam (./purgeExtension.ts); ink v2 (`accept-ink: 2`) on the sync and read paths
//  * (Academic OS P1-T2 step 3) «انقل ملاحظاتي إلى الإصدار الجديد» — copy, never move (./reanchorCopy.ts):
//    GET /reanchor-copy (read-only preview), POST /reanchor-copy (the owner's tap), POST /reanchor-copy/undo; the review
//    list's decisions reuse Round 7's POST /reanchor with `action: 'copy' | 'keep_on_previous' | 'review_again'`
import {
  ACCEPT_INK_HEADER,
  copyLayersRequestSchema,
  documentKeySchema,
  layerCreateSchema,
  layerPatchSchema,
  parseAcceptInk,
  reanchorCopyActionSchema,
  reanchorCopyRunSchema,
  reanchorCopyUndoSchema,
  type CopyLayersResponse,
  type ReanchorCopyActionResponse,
  type ReanchorCopyPreview,
  type ReanchorCopyRunResponse,
  type LayerHistoryPage,
  type LayersResponse,
  type LayerView,
} from '@medlevo/shared';
import type {
  AskContextResponse,
  RecognitionListResponse,
  RecognitionResponse,
  AnnotationImageUploadResponse,
  AnnotationImageView,
  AnnotationsByTargetsResponse,
  LatestSessionResponse,
  NeedsReanchorResponse,
  NotebookContentResponse,
  NotePagesResponse,
  NotesResponse,
  OrphanNotePagesResponse,
  PageCropResponse,
  ReanchorResponse,
  ReadingProgressView,
  RecentSessionsResponse,
  SourceAnnotationsResponse,
} from '@medlevo/shared';
import type { FastifyInstance } from 'fastify';
import { newId } from '@medlevo/shared';
import { z } from 'zod';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery, RATE_LIMITS } from '../../lib/http';
import { sendStoredFile } from '../files';
import { assertImageKey, getAnnotationImage, toImageView, uploadAnnotationImage } from './images';
import {
  askContext,
  correctRecognition,
  createRecognition,
  deleteRecognition,
  getRecognitionRow,
  listRecognitions,
  recognitionImage,
  recognitionListQuery,
  recognitionView,
  registerRecognitionJob,
  retryRecognition,
} from './recognition';
import { detectTools } from '../processing/tools';
import { createPageCrop, pageCropBody } from './pageCrop';
import { reanchor } from './reanchor';
import { previewReanchorCopy, reanchorCopyAction, runReanchorCopy, undoReanchorCopy } from './reanchorCopy';
import { AnnotationsService, MAX_TARGET_KEYS } from './service';
import { registerAnnotationSync } from './sync';
import { listLayerHistory } from './history';
import { copyLayer } from './layerCopy';
import { defaultLayerRow, getLayer, layerOpPayload, listLayers } from './layers';
import { registerLayersPurge, registerReanchorCopyPurge } from './purgeExtension';

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
const flag = z.enum(['0', '1', 'true', 'false']).optional();
const isOn = (v: string | undefined) => v === '1' || v === 'true';
const notePagesQuery = z
  .object({ node_id: ID.optional(), source_id: ID.optional(), orphans: flag, include_deleted: flag })
  .refine((q) => !!q.node_id || !!q.source_id || isOn(q.orphans), { message: 'حدّد الدفتر (node_id) أو المصدر (source_id) أو اطلب الصفحات بلا دفتر (orphans=1).' });
const orphanQuery = z.object({ include_deleted: flag });
const nodeParams = z.object({ nodeId: ID });
const imageParams = z.object({ key: ID });
const reanchorQuery = z.object({ source_id: ID.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const latestQuery = z.object({ source_id: ID });
const reanchorCopyQuery = z.object({ source_id: ID, from_version_id: ID.optional(), to_version_id: ID.optional() });
const CROSS_VERSION_ACTIONS = new Set(['copy', 'keep_on_previous', 'review_again']);
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

const layersQuery = z.object({ document_key: documentKeySchema });
const layerParams = z.object({ id: ID });
const historyQuery = z.object({
  document_key: documentKeySchema.optional(),
  before: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  registerAnnotationSync(ctx.sync, ctx.db);
  // (P1-T2) a purge deletes the layers of purged documents, and the history and attribution of purged items
  registerLayersPurge(ctx);
  // (P1-T2 step 3) a purge deletes the note-migration records of purged lectures, versions and items
  registerReanchorCopyPurge(ctx);
  const svc = new AnnotationsService(ctx);

  ctx.capabilities.set('workspace.reader', 'available');
  // The ink engine (web, features/workspace/ink) stores strokes locally first and syncs them through the
  // 'annotation' entity registered above. The ink track verifies the engine itself; pressure/tilt/palm
  // rejection are reported per device by the engine (§27), not promised here.
  ctx.capabilities.set('workspace.ink', 'available');
  // (track F4) handwriting recognition: built; the registry turns it into `requires_configuration` (with the reason)
  // when no vision-capable AI provider is configured (FEATURE_AI_TASK / AI_DEPENDENT_FEATURES).
  ctx.capabilities.set('workspace.handwriting_recognition', 'available');
  registerRecognitionJob(ctx);
  // (P1-T2, ADR-0005 B.4) the e-ink display mode is built (web: design/themeDisplay.ts). It is a setting of each device,
  // suggested only when the browser reports `(update: slow)`; no device is named or detected. Native e-ink paths
  // (BOOX pen SDK) are separate and not built (PL-3).
  ctx.capabilities.set('ui.eink_mode', 'available');

  app.get('/by-targets', async (req): Promise<AnnotationsByTargetsResponse> => {
    const q = parseQuery(byTargetsQuery, req);
    const keys = [...new Set(q.keys.split(',').map((k) => k.trim()).filter(Boolean))];
    if (keys.length > MAX_TARGET_KEYS) {
      throw new AppError('VALIDATION_FAILED', `عدد الصفحات المطلوبة في طلب واحد أكبر من الحد (${MAX_TARGET_KEYS}).`, 400);
    }
    return { annotations: svc.byTargets(keys, q.include_deleted === '1' || q.include_deleted === 'true', parseAcceptInk(req.headers[ACCEPT_INK_HEADER])) };
  });

  app.get('/source/:sourceId', async (req): Promise<SourceAnnotationsResponse> => {
    const { sourceId } = parseParams(sourceParams, req);
    const q = parseQuery(versionQuery, req);
    return svc.forSource(sourceId, q.version_id, parseAcceptInk(req.headers[ACCEPT_INK_HEADER]));
  });

  // ── (P1-T2) authorship layers (ARCHITECTURE_DELTA §7.5) ──
  app.get('/layers', async (req): Promise<LayersResponse> => {
    const q = parseQuery(layersQuery, req);
    return { document_key: q.document_key, layers: listLayers(ctx.db, q.document_key, ctx.clock.now()) };
  });

  /** A REST layer write is applied as a sync op of this server: same rules, recorded, in the change feed for devices. */
  const applyLayerOp = (id: string, payload: unknown, baseRev: number | null, deviceId: string | null): LayerView => {
    const res = ctx.sync.push([
      { op_id: `rest_${newId(ctx.clock.now())}`, device_id: deviceId ?? 'server', entity_type: 'annotation_layer', entity_id: id, op: 'upsert', base_rev: baseRev, payload, client_ts: ctx.clock.now() },
    ]).results[0]!;
    if (res.result === 'rejected') {
      throw new AppError(res.detail_code === 'layer_read_only' ? 'LAYER_READ_ONLY' : 'VALIDATION_FAILED', res.detail ?? 'تعذّر حفظ الطبقة.', res.detail_code === 'layer_read_only' ? 409 : 400, res.detail_code ? { detail_code: res.detail_code } : undefined);
    }
    const row = getLayer(ctx.db, id)!;
    return listLayers(ctx.db, row.document_key, ctx.clock.now()).find((l) => l.id === id)!;
  };
  const deviceOf = (req: { headers: Record<string, unknown> }) => {
    const d = req.headers['x-medlevo-device'];
    return typeof d === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d) ? d : null;
  };

  app.post('/layers', async (req): Promise<LayerView> => {
    const b = parseBody(layerCreateSchema, req);
    return applyLayerOp(b.id, { ...b }, null, deviceOf(req));
  });

  app.patch('/layers/:id', async (req): Promise<LayerView> => {
    const { id } = parseParams(layerParams, req);
    const patch = parseBody(layerPatchSchema, req);
    const q = parseQuery(z.object({ document_key: documentKeySchema.optional() }), req);
    const row = getLayer(ctx.db, id) ?? (q.document_key ? defaultLayerRow(ctx.db, q.document_key, ctx.clock.now()) : undefined);
    if (!row || row.id !== id || row.deleted_at !== null) throw new AppError('NOT_FOUND', 'الطبقة غير موجودة.', 404);
    return applyLayerOp(id, layerOpPayload(row, patch), getLayer(ctx.db, id) ? row.rev : null, deviceOf(req));
  });

  app.post('/layers/copy', async (req): Promise<CopyLayersResponse> => copyLayer(ctx, parseBody(copyLayersRequestSchema, req), { deviceId: deviceOf(req) }));

  app.get('/layers/:id/history', async (req): Promise<LayerHistoryPage> => {
    const { id } = parseParams(layerParams, req);
    const q = parseQuery(historyQuery, req);
    return listLayerHistory(ctx.db, id, { documentKey: q.document_key, before: q.before, limit: q.limit });
  });

  app.get('/notes', async (req): Promise<NotesResponse> => {
    const q = parseQuery(notesQuery, req);
    return { notes: svc.notes(q) };
  });

  // ── notebook pages (track F1): trashed pages are listed only for the restore list ──
  app.get('/note-pages', async (req): Promise<NotePagesResponse> => {
    const q = parseQuery(notePagesQuery, req);
    return { note_pages: svc.notePages({ node_id: q.node_id, source_id: q.source_id, orphans: isOn(q.orphans), include_deleted: isOn(q.include_deleted) }) };
  });

  // (Round 7 — H3 item 7) «صفحات بلا دفتر»: pages whose notebook and source were purged while a device still wrote on
  // them offline — kept, listed with their writing so the owner can move them into a notebook or trash them
  app.get('/orphan-pages', async (req): Promise<OrphanNotePagesResponse> => svc.orphanPages(isOn(parseQuery(orphanQuery, req).include_deleted)));

  app.get('/notebook/:nodeId', async (req): Promise<NotebookContentResponse> => {
    const { nodeId } = parseParams(nodeParams, req);
    return svc.notebook(nodeId);
  });

  // ── pictures placed on pages: bytes by image_key, independent of the annotation's sync op ──
  app.post('/images', { config: { rateLimit: RATE_LIMITS.upload } }, async (req): Promise<AnnotationImageUploadResponse> => uploadAnnotationImage(ctx, req));

  const missingImage = () => new AppError('NOT_FOUND', 'لم تصل هذه الصورة إلى الخادم بعد؛ تُرفع من الجهاز الذي أُضيفت منه عندما يتصل.', 404);

  app.get('/images/:key/meta', async (req): Promise<AnnotationImageView> => {
    const { key } = parseParams(imageParams, req);
    assertImageKey(key);
    const row = getAnnotationImage(ctx, key);
    if (!row) throw missingImage();
    return toImageView(ctx, row);
  });

  app.get('/images/:key', async (req, reply) => {
    const { key } = parseParams(imageParams, req);
    assertImageKey(key);
    const row = getAnnotationImage(ctx, key);
    const file = row ? ctx.files.stat(row.file_id) : null;
    if (!row || !file) throw missingImage();
    return sendStoredFile(ctx.files, file, req, reply);
  });

  // ── handwriting recognition (track F4): a DERIVED, correctable reading; the ink itself is never touched ──
  const recParams = z.object({ id: ID });
  app.post('/recognitions', { bodyLimit: 6 * 1024 * 1024, config: { rateLimit: RATE_LIMITS.upload } }, async (req, reply): Promise<RecognitionResponse> => {
    const r = createRecognition(ctx, req.body ?? {});
    if (r.created) reply.code(202);
    return { recognition: r.view };
  });
  app.get('/recognitions', async (req): Promise<RecognitionListResponse> => ({ recognitions: listRecognitions(ctx, parseQuery(recognitionListQuery, req)) }));
  app.get('/recognitions/:id', async (req): Promise<RecognitionResponse> => ({ recognition: recognitionView(ctx, getRecognitionRow(ctx, parseParams(recParams, req).id)) }));
  app.patch('/recognitions/:id', async (req): Promise<RecognitionResponse> => ({ recognition: correctRecognition(ctx, parseParams(recParams, req).id, req.body ?? {}) }));
  app.post('/recognitions/:id/retry', async (req): Promise<RecognitionResponse> => ({ recognition: retryRecognition(ctx, parseParams(recParams, req).id) }));
  app.delete('/recognitions/:id', async (req) => {
    deleteRecognition(ctx, parseParams(recParams, req).id);
    return { ok: true };
  });
  app.get('/recognitions/:id/image', async (req, reply) => {
    const png = recognitionImage(ctx, parseParams(recParams, req).id);
    reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff');
    return reply.send(png);
  });
  app.post('/ask-context', async (req): Promise<AskContextResponse> => askContext(ctx, req.body ?? {}));

  app.get('/needs-reanchor', async (req): Promise<NeedsReanchorResponse> => {
    const q = parseQuery(reanchorQuery, req);
    // (H3 item 2) annotations, notes, and what the owner kept detached («محفوظة دون ربط»)
    const lists = svc.reanchorLists(q.source_id, q.limit);
    return { items: lists.items, notes: lists.notes, detached: lists.detached };
  });

  // (H3 item 2) the owner's re-anchoring decision for a note / highlight / ink group: move it to a chosen place (a page,
  // a paragraph on a page, a Study Book paragraph) or keep it detached — previous anchor kept, audited, synced
  // (P1-T2 step 3) the same route, reused AS A COPY for the cross-version review list: `action: 'copy'` copies the items to
  // the page picked on the newer version (the originals stay on theirs), `keep_on_previous` / `review_again` record the
  // owner's choice — nothing is ever moved off its version from here
  app.post('/reanchor', async (req): Promise<ReanchorResponse | ReanchorCopyActionResponse> => {
    const action = (req.body as { action?: unknown } | null | undefined)?.action;
    if (typeof action === 'string' && CROSS_VERSION_ACTIONS.has(action)) return reanchorCopyAction(ctx, parseBody(reanchorCopyActionSchema, req), { deviceId: deviceOf(req) });
    return reanchor(ctx, req);
  });

  // (P1-T2 step 3) «انقل ملاحظاتي إلى الإصدار الجديد»: the preview (read-only: nothing changes before the tap), the tap
  // (one transaction; a second tap copies nothing) and the one-step undo (tombstones that run's copies only)
  app.get('/reanchor-copy', async (req): Promise<ReanchorCopyPreview> => previewReanchorCopy(ctx, parseQuery(reanchorCopyQuery, req)));
  app.post('/reanchor-copy', async (req): Promise<ReanchorCopyRunResponse> => runReanchorCopy(ctx, parseBody(reanchorCopyRunSchema, req), { deviceId: deviceOf(req) }));
  app.post('/reanchor-copy/undo', async (req): Promise<ReanchorCopyRunResponse> => undoReanchorCopy(ctx, parseBody(reanchorCopyUndoSchema, req).run_id, { deviceId: deviceOf(req) }));

  // (H3 item 4) «بطاقة إخفاء في صورة» from a lasso selection: the source page area under the box, cut by the server from
  // the stored source file (pdftoppm for PDFs — refused with the reason when it is not installed)
  let pdftoppm: string | null | undefined;
  app.post('/page-crops', { config: { rateLimit: RATE_LIMITS.upload } }, async (req): Promise<PageCropResponse> => {
    const body = parseBody(pageCropBody, req);
    if (pdftoppm === undefined) pdftoppm = detectTools().pdftoppm;
    return createPageCrop(ctx, body, { pdftoppm });
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
