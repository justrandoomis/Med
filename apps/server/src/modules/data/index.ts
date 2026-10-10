// Data module (/api/data) — track D1: offline downloads (Download Manager), backups + restore verification,
// exports, and the server data epoch used by sync after a restore. Spec §46, §47, §49; AC-23, AC-30.
// Owns: data_server_epoch, data_backup (migration 0750). Reads other modules' tables; renders their views by
// forwarding GET requests in-process with the owner's own session (never a second implementation of a view).
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  OFFLINE_MANIFEST_FORMAT,
  type BackupCreateResponse,
  type BackupsListResponse,
  type ExportFormatsResponse,
  type OfflineBundleResponse,
  type OfflineLearningResponse,
  type OfflineManifestResponse,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseParams, parseQuery } from '../../lib/http';
import { BACKUP_EXCLUDED } from './backup';
import {
  BACKUP_INCLUDED_AR,
  BACKUP_STORAGE_NOTE_AR,
  archiveForDownload,
  backupView,
  deleteBackup,
  getBackupRow,
  listBackups,
  markInterruptedBackups,
  registerBackupJobs,
  startBackup,
  startVerify,
} from './backups';
import { currentEpoch, ensureEpoch } from './epoch';
import { exportAll, exportArtifact, exportNotes, exportQuestions, exportSource, type ExportFile } from './export';
import { buildOfflinePackage, learningForSource, resolveOfflineTarget, type Forward } from './offline';

export { currentEpoch, ensureEpoch, startRestoreEpoch, syncHeadSeq, type ServerEpoch } from './epoch';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const flag = z.enum(['0', '1', 'true', 'false']).optional();
const isOn = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : v === '1' || v === 'true');

const sourceParams = z.object({ sourceId: ID });
const idParams = z.object({ id: ID });
const offlineQuery = z.object({ version: ID.optional(), include_solutions: flag });
const formatQuery = z.object({ format: z.enum(EXPORT_FORMATS).default('md') });
const sourceExportQuery = formatQuery.extend({ version: ID.optional() });
const notesExportQuery = formatQuery.extend({ source_id: ID.optional(), node_id: ID.optional() });
const questionsExportQuery = formatQuery.extend({
  source_id: ID.optional(),
  lecture_source_id: ID.optional(),
  include_solutions: flag,
});

/** Per-route limits for the new endpoints (single owner; generous for reading, strict for heavy work). */
const LIMITS = {
  offline: { max: 60, timeWindow: 60_000 },
  exportRoute: { max: 30, timeWindow: 60_000 },
  backupCreate: { max: 3, timeWindow: 10 * 60_000 },
  backupVerify: { max: 3, timeWindow: 10 * 60_000 },
  download: { max: 20, timeWindow: 60_000 },
  manage: { max: 60, timeWindow: 60_000 },
} as const;

function sendFile(reply: FastifyReply, f: ExportFile) {
  const ascii = f.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  reply.header('content-type', f.contentType);
  reply.header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
  reply.header('cache-control', 'private, no-store');
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(f.body);
}

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ensureEpoch(ctx.db, ctx.clock.now());
  registerBackupJobs(ctx);
  markInterruptedBackups(ctx);

  ctx.capabilities.set('offline', 'available');
  ctx.capabilities.set('backup', 'available');
  ctx.capabilities.set('export.markdown', 'available');
  // PDF = print the HTML export from the browser (the UI says so); no server-side PDF renderer exists
  ctx.capabilities.set('export.pdf', 'available');
  ctx.capabilities.set('export.docx', 'not_implemented', 'تصدير DOCX غير مبني؛ استخدم Markdown أو HTML (والطباعة إلى PDF من المتصفح).');

  const forwardFor =
    (req: FastifyRequest): Forward =>
    async (path) => {
      const res = await app.inject({ method: 'GET', url: path, headers: { cookie: req.headers.cookie ?? '', 'user-agent': 'medlevo-data-forward' } });
      return { status: res.statusCode, body: res.body };
    };

  // ───────── offline downloads ─────────
  app.get('/offline/:sourceId/manifest', { config: { rateLimit: LIMITS.offline } }, async (req): Promise<OfflineManifestResponse> => {
    const { sourceId } = parseParams(sourceParams, req);
    const q = parseQuery(offlineQuery, req);
    const built = await buildOfflinePackage(ctx, forwardFor(req), { sourceId, versionId: q.version ?? null, includeSolutions: isOn(q.include_solutions, true) });
    return built.manifest;
  });

  app.get('/offline/:sourceId/bundle', { config: { rateLimit: LIMITS.offline } }, async (req): Promise<OfflineBundleResponse> => {
    const { sourceId } = parseParams(sourceParams, req);
    const q = parseQuery(offlineQuery, req);
    const built = await buildOfflinePackage(ctx, forwardFor(req), { sourceId, versionId: q.version ?? null, includeSolutions: isOn(q.include_solutions, true) });
    return {
      format: OFFLINE_MANIFEST_FORMAT,
      source_id: built.manifest.source.id,
      version_id: built.manifest.version.id,
      content_hash: built.manifest.content_hash,
      generated_at: built.manifest.generated_at,
      entries: built.bundle,
    };
  });

  app.get('/offline/:sourceId/learning', { config: { rateLimit: LIMITS.offline } }, async (req): Promise<OfflineLearningResponse> => {
    const { sourceId } = parseParams(sourceParams, req);
    resolveOfflineTarget(ctx, sourceId, null);
    return learningForSource(ctx, sourceId);
  });

  // ───────── server epoch (diagnostics; sync pull carries it too) ─────────
  app.get('/epoch', async () => {
    const e = currentEpoch(ctx.db);
    return { epoch: e ? { id: e.id, started_at: e.started_at, base_seq: e.base_seq, reason: e.reason, backup_created_at: e.backup_created_at } : null };
  });

  // ───────── backups ─────────
  app.get('/backups', { config: { rateLimit: LIMITS.manage } }, async (): Promise<BackupsListResponse> => ({
    backups: listBackups(ctx),
    included_ar: BACKUP_INCLUDED_AR,
    excluded_ar: BACKUP_EXCLUDED,
    storage_note_ar: BACKUP_STORAGE_NOTE_AR,
  }));

  app.post('/backups', { config: { rateLimit: LIMITS.backupCreate } }, async (): Promise<BackupCreateResponse> => ({ backup: startBackup(ctx) }));

  app.get('/backups/:id', { config: { rateLimit: LIMITS.manage } }, async (req): Promise<BackupCreateResponse> => {
    const { id } = parseParams(idParams, req);
    return { backup: backupView(ctx, getBackupRow(ctx, id)) };
  });

  app.post('/backups/:id/verify', { config: { rateLimit: LIMITS.backupVerify } }, async (req): Promise<BackupCreateResponse> => {
    const { id } = parseParams(idParams, req);
    return { backup: startVerify(ctx, id) };
  });

  app.get('/backups/:id/download', { config: { rateLimit: LIMITS.download } }, async (req, reply) => {
    const { id } = parseParams(idParams, req);
    const f = archiveForDownload(ctx, id);
    reply.header('content-type', 'application/gzip');
    reply.header('content-length', String(f.size));
    reply.header('content-disposition', `attachment; filename="${f.fileName}"`);
    reply.header('cache-control', 'private, no-store');
    ctx.audit.record({ entityType: 'backup', entityId: id, action: 'download', summary: `تنزيل نسخة احتياطية (${f.fileName})` });
    return reply.send(createReadStream(f.path));
  });

  app.delete('/backups/:id', { config: { rateLimit: LIMITS.manage } }, async (req) => {
    const { id } = parseParams(idParams, req);
    deleteBackup(ctx, id);
    return { ok: true };
  });

  // ───────── exports ─────────
  app.get('/export/formats', async (): Promise<ExportFormatsResponse> => {
    const anki = ctx.capabilities.get('export.anki_tsv');
    const docx = ctx.capabilities.get('export.docx');
    return {
      formats: [
        { format: 'md', label_ar: 'Markdown', note_ar: 'نص منظم مع الاستشهادات نصًّا (المصدر — الصفحة — الإصدار + الاقتباس). لا روابط داخلية.' },
        { format: 'html', label_ar: 'HTML للطباعة', note_ar: 'صفحة من اليمين لليسار مع عزل المصطلحات الإنجليزية، جاهزة للطباعة.' },
        { format: 'json', label_ar: 'JSON كامل', note_ar: 'البيانات المنظمة مع manifest للمعرّفات والإصدارات وبصمات المحتوى.' },
      ],
      pdf_note_ar: 'PDF عبر الطباعة من المتصفح: افتح تصدير HTML ثم «طباعة» ← «حفظ بصيغة PDF». لا يوجد مولّد PDF على الخادم.',
      other: [
        { key: 'export.anki_tsv', label_ar: 'بطاقات Anki (TSV)', available: anki.state === 'available', reason_ar: anki.state === 'available' ? 'من شاشة المراجعة (البطاقات).' : (anki.reason_ar ?? null) },
        { key: 'export.docx', label_ar: 'DOCX', available: docx.state === 'available', reason_ar: docx.reason_ar ?? null },
      ],
    };
  });

  app.get('/export/source/:sourceId', { config: { rateLimit: LIMITS.exportRoute } }, async (req, reply) => {
    const { sourceId } = parseParams(sourceParams, req);
    const q = parseQuery(sourceExportQuery, req);
    return sendFile(reply, await exportSource(ctx, forwardFor(req), sourceId, q.version ?? null, q.format));
  });

  app.get('/export/artifact/:id', { config: { rateLimit: LIMITS.exportRoute } }, async (req, reply) => {
    const { id } = parseParams(idParams, req);
    const q = parseQuery(formatQuery, req);
    return sendFile(reply, await exportArtifact(ctx, forwardFor(req), id, q.format));
  });

  app.get('/export/notes', { config: { rateLimit: LIMITS.exportRoute } }, async (req, reply) => {
    const q = parseQuery(notesExportQuery, req);
    return sendFile(reply, exportNotes(ctx, { sourceId: q.source_id, nodeId: q.node_id }, q.format));
  });

  app.get('/export/questions', { config: { rateLimit: LIMITS.exportRoute } }, async (req, reply) => {
    const q = parseQuery(questionsExportQuery, req);
    return sendFile(
      reply,
      await exportQuestions(ctx, forwardFor(req), { sourceId: q.source_id, lectureSourceId: q.lecture_source_id }, q.format, isOn(q.include_solutions, true)),
    );
  });

  app.get('/export/all', { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (_req, reply) => sendFile(reply, exportAll(ctx)));
}
