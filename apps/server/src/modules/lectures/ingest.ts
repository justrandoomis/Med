// Files into a subject space (P1-T5 step 1; ARCHITECTURE_DELTA §7.4 «reuses sources upload + processing in the space»).
// The request is bound to the SPACE, so the existing upload inspection (type from content, PDF / OOXML / image checks),
// the content-addressed store (one blob per sha256 across every database — no byte copy when a vault already holds the
// same file) and the processing pipeline (job in the space's own queue) all act on the space database.
//
// One file per request, as multipart/form-data (the web client sends one file per request for real progress). The
// JSON `{upload_id}` form of the contract needs a resumable upload made INTO this space, which P1-T1's chunked uploads
// do not create yet (target: space is refused there); such an id is «not found» here.
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import type { SourceFormat, SourceType } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { randomToken, sha256File } from '../../lib/hash';
import { newId } from '../../lib/ids';
import { removeStoredFileIfUnreferenced } from '../sources/purge';
import { cleanFileName } from '../sources/sniff';
import { finishProcessingSetup, type IncomingFile, inspectFile, processingRegistered } from '../sources/upload';

export interface OneFileMultipart {
  fields: Record<string, string>;
  file: IncomingFile | null;
  cleanup(): void;
}

/** Stream the single file part to a private temp file (never buffered whole); collect the text fields. */
export async function readOneFile(ctx: AppContext, req: FastifyRequest): Promise<OneFileMultipart> {
  const fields: Record<string, string> = {};
  const files: IncomingFile[] = [];
  const cleanup = () => {
    for (const f of files) rmSync(f.tmpPath, { force: true });
  };
  try {
    const parts = req.parts({ throwFileSizeLimit: false } as Parameters<FastifyRequest['parts']>[0]);
    for await (const part of parts) {
      if (part.type === 'file') {
        // one file per request: a second file part is refused before a byte of it is stored
        if (files.length > 0) throw new AppError('BAD_REQUEST', 'أرسل ملفًا واحدًا في كل طلب.', 400);
        const tmpPath = join(ctx.config.tmpDir, `official-${randomToken(12)}`);
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
  if (files.length > 1) {
    cleanup();
    throw new AppError('BAD_REQUEST', 'أرسل ملفًا واحدًا في كل طلب.', 400);
  }
  if (files[0]?.truncated) {
    cleanup();
    throw new AppError('PAYLOAD_TOO_LARGE', 'حجم الملف أكبر من الحد المسموح للرفع.', 413);
  }
  return { fields, file: files[0] ?? null, cleanup };
}

interface StoredParts {
  fileId: string | null;
  originalFileId: string | null;
  pages: Array<{ fileId: string; path: string; width: number | null; height: number | null }>;
}

const ids = (p: StoredParts) => [...new Set([p.fileId, p.originalFileId, ...p.pages.map((x) => x.fileId)].filter((x): x is string => !!x))];

export interface IngestTarget {
  /** the space's source that receives the new version */
  sourceId: string;
  /** checked inside the registration transaction (the target may change while the file is inspected and stored) */
  stillWritable(): void;
  /** extra rows written in the SAME transaction as the version (official_version_upload, statuses, events) */
  register(versionId: string, versionNo: number): void;
}

export interface Ingested {
  versionId: string;
  versionNo: number;
  jobId: string;
  fileId: string | null;
  format: SourceFormat;
}

/**
 * Inspect, store and register ONE uploaded file as a new version of `target.sourceId` in the bound space, then queue
 * its processing. Refuses (nothing stored) an unsupported, damaged or audio file, and bytes this source already holds.
 */
export async function ingestVersion(ctx: AppContext, file: IncomingFile, target: IngestTarget): Promise<Ingested> {
  if (!processingRegistered(ctx)) throw new AppError('FEATURE_DISABLED', 'وحدة معالجة المستندات غير متاحة في هذا الخادم، لذلك لا يمكن رفع محاضرات رسمية الآن.', 409);
  if (file.size === 0) throw new AppError('BAD_REQUEST', 'الملف فارغ.', 400);
  const insp = await inspectFile(ctx, file);
  try {
    if (!insp.ok) throw new AppError('UNSUPPORTED_FORMAT', insp.reason, 415, { detected_format: insp.detected, rejected_entries: insp.rejected_entries ?? [] });
    if (insp.format === 'audio') throw new AppError('UNSUPPORTED_FORMAT', 'المحاضرات الرسمية والملفات المرفقة مستندات أو صور؛ التسجيلات الصوتية تُشارَك لاحقًا بموافقة صريحة.', 415);
    const { sha256: contentHash } = await sha256File(file.tmpPath);
    const same = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE source_id = ? AND content_hash = ?', [target.sourceId, contentHash]);
    if (same) throw new AppError('CONFLICT', `هذا الملف مطابق للإصدار ${same.version_no}؛ لم يُنشأ إصدار جديد.`, 409, { version_no: same.version_no });

    const put = (path: string, mime: string, name: string) => ctx.files.put(createReadStream(path), { mime, originalName: name, maxBytes: ctx.config.limits.maxUploadBytes });
    const parts: StoredParts = { fileId: null, originalFileId: null, pages: [] };
    if (insp.format === 'image_set') {
      parts.originalFileId = (await put(file.tmpPath, 'application/zip', file.fileName)).id;
      for (const img of insp.images ?? []) {
        const stored = await put(img.filePath, img.mime, img.path.split('/').pop() ?? img.path);
        parts.pages.push({ fileId: stored.id, path: img.path, width: img.width, height: img.height });
      }
    } else {
      const stored = await put(file.tmpPath, insp.mime, file.fileName);
      if (insp.convertOnly) parts.originalFileId = stored.id;
      else {
        parts.fileId = stored.id;
        if (insp.format === 'image') parts.pages.push({ fileId: stored.id, path: file.fileName, width: insp.image?.width ?? null, height: insp.image?.height ?? null });
      }
    }

    const now = ctx.clock.now();
    const versionId = newId(now);
    let versionNo = 0;
    try {
      ctx.db.tx(() => {
        target.stillWritable();
        const prev = ctx.db.get<{ id: string; version_no: number } | undefined>('SELECT id, version_no FROM source_version WHERE source_id = ? ORDER BY version_no DESC LIMIT 1', [target.sourceId]);
        versionNo = (prev?.version_no ?? 0) + 1;
        ctx.db.run(
          `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, original_file_id, content_hash, mime, file_name, format,
             page_count, pagination, processing_status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [versionId, target.sourceId, versionNo, versionNo === 1 ? 'original' : 'replacement', prev?.id ?? null, parts.fileId, parts.originalFileId, contentHash, insp.mime, file.fileName, insp.format, insp.pageCount, insp.pagination, insp.note ?? null, now],
        );
        parts.pages.forEach((p, i) => {
          ctx.db.run(
            `INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, render_file_id, section_key, created_at, updated_at)
             VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`,
            [newId(now), versionId, i, p.width, p.height, p.width !== null ? 'px' : null, p.fileId, p.path, now, now],
          );
        });
        ctx.db.run(`UPDATE source SET processing_status = 'pending', updated_at = ? WHERE id = ?`, [now, target.sourceId]);
        target.register(versionId, versionNo);
      });
    } catch (e) {
      for (const id of ids(parts)) {
        try {
          removeStoredFileIfUnreferenced(ctx, id);
        } catch (cleanupErr) {
          ctx.log.warn({ err: cleanupErr, fileId: id }, 'could not remove the file of a refused official upload');
        }
      }
      throw e;
    }
    const job = finishProcessingSetup(ctx, versionId, insp.format, insp.pageCount, versionNo === 1 ? 'upload' : 'replacement');
    if (!job) throw new AppError('INTERNAL', 'حُفظ الملف لكن تعذّر بدء معالجته. أعد المعالجة من «المحتوى الرسمي».', 500);
    return { versionId, versionNo, jobId: job.id, fileId: parts.fileId ?? parts.originalFileId, format: insp.format };
  } finally {
    if (insp.ok && insp.cleanupDir) rmSync(insp.cleanupDir, { recursive: true, force: true });
  }
}

/** A new, empty source of the space (an official lecture's identity or an attachment) — no version until a file arrives. */
export function createSpaceSource(ctx: AppContext, s: { title: string; sourceType: SourceType; lectureNo?: number | null; heldOn?: string | null }): string {
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.run(
    `INSERT INTO source (id, title, source_type, source_type_origin, node_id, metadata_status, processing_status, lecture_no, lecture_no_origin, held_on, held_on_origin, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', NULL, 'unknown', 'pending', ?, ?, ?, ?, ?, ?)`,
    [id, s.title, s.sourceType, s.lectureNo ?? null, s.lectureNo ? 'moderator' : null, s.heldOn ?? null, s.heldOn ? 'moderator' : null, now, now],
  );
  return id;
}
