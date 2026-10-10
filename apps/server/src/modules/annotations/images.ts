// Pictures placed on pages (image annotations, §26 «Image» tool) — track F1.
//
//  * The bytes travel separately from the annotation's sync op: POST /api/annotations/images {image_key, file}
//    stores them under the client's image_key (a ULID). The upload is idempotent by key, so a retry after a lost
//    response never stores twice, and either the upload or the annotation may reach the server first.
//  * The content is sniffed (magic bytes, never the client's MIME): PNG / JPEG / WebP / GIF only, at most
//    ANNOTATION_IMAGE_MAX_BYTES and ANNOTATION_IMAGE_MAX_SIDE pixels on a side. SVG / HTML are refused (no active
//    content is ever served back), and the file is served with nosniff from the private file store.
//  * annotation_image.file_id references stored_file, so the sources purge never deletes a picture another page
//    still shows (removeStoredFileIfUnreferenced checks every foreign key into stored_file), and the backup carries it
//    (every stored_file row is archived). `pruneAnnotationImages` removes pictures no annotation points at any more.
import { ANNOTATION_IMAGE_MAX_BYTES, ANNOTATION_IMAGE_MAX_SIDE, ANNOTATION_IMAGE_MIMES, type AnnotationImageMime, type AnnotationImageView } from '@medlevo/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { imageSize, sniff } from '../sources/sniff';
import { removeStoredFileIfUnreferenced } from '../sources/purge';

export interface AnnotationImageRow {
  image_key: string;
  file_id: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  referenced: number;
  device_id: string | null;
  created_at: number;
}

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** An uploaded picture nobody has pointed at for this long is considered abandoned (never synced). */
export const UNREFERENCED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function getAnnotationImage(ctx: AppContext, key: string): AnnotationImageRow | undefined {
  return ctx.db.get<AnnotationImageRow>('SELECT * FROM annotation_image WHERE image_key = ?', [key]);
}

/** Annotations (live, or tombstoned — an undo restores them) that show this picture. */
function annotationsUsing(ctx: AppContext, key: string, liveOnly: boolean): number {
  return (
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM annotation WHERE kind = 'image' AND json_extract(data_json, '$.image_key') = ?${liveOnly ? ' AND deleted_at IS NULL' : ''}`,
      [key],
    )?.n ?? 0
  );
}

export function toImageView(ctx: AppContext, r: AnnotationImageRow): AnnotationImageView {
  return { image_key: r.image_key, file_id: r.file_id, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, used_by: annotationsUsing(ctx, r.image_key, true), created_at: r.created_at };
}

export function assertImageKey(key: string): void {
  if (!KEY_RE.test(key)) throw new AppError('VALIDATION_FAILED', 'معرّف الصورة غير صالح.', 400);
}

/** Read the multipart body: the `image_key` field and ONE file (buffered; at most the size limit + 1 byte). */
async function readImageUpload(req: FastifyRequest): Promise<{ key: string; deviceId: string | null; name: string | null; buf: Buffer; truncated: boolean }> {
  if (!req.isMultipart()) throw new AppError('UNSUPPORTED_FORMAT', 'يجب إرسال الصورة بصيغة multipart/form-data.', 415);
  let key = '';
  let deviceId: string | null = null;
  let name: string | null = null;
  let buf: Buffer | null = null;
  let truncated = false;
  const parts = req.parts({ limits: { fileSize: ANNOTATION_IMAGE_MAX_BYTES, files: 1 }, throwFileSizeLimit: false } as Parameters<FastifyRequest['parts']>[0]);
  for await (const part of parts) {
    if (part.type === 'file') {
      if (buf) {
        part.file.resume();
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const c of part.file) chunks.push(c as Buffer);
      buf = Buffer.concat(chunks);
      truncated = part.file.truncated === true;
      name = typeof part.filename === 'string' && part.filename ? part.filename.slice(0, 255) : null;
    } else if (part.fieldname === 'image_key' && typeof part.value === 'string') {
      key = part.value.trim();
    } else if (part.fieldname === 'device_id' && typeof part.value === 'string' && KEY_RE.test(part.value.trim())) {
      deviceId = part.value.trim();
    }
  }
  if (!buf) throw new AppError('VALIDATION_FAILED', 'أرفق الصورة.', 400);
  return { key, deviceId, name, buf, truncated };
}

/** POST /api/annotations/images — store (or recognise again) the picture of an image annotation. */
export async function uploadAnnotationImage(ctx: AppContext, req: FastifyRequest): Promise<{ image: AnnotationImageView; duplicate: boolean }> {
  const { key, deviceId, name, buf, truncated } = await readImageUpload(req);
  assertImageKey(key);
  if (truncated || buf.length > ANNOTATION_IMAGE_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'الصورة أكبر من الحد المسموح (10 ميغابايت). صغّرها ثم أعد إدراجها.', 413);
  }
  const s = sniff(buf.subarray(0, 64 * 1024));
  if (s.kind !== 'image' || !(ANNOTATION_IMAGE_MIMES as readonly string[]).includes(s.mime)) {
    throw new AppError('UNSUPPORTED_FORMAT', 'هذا الملف ليس صورة مدعومة. أدرج صورة PNG أو JPEG أو WebP أو GIF.', 415);
  }
  const mime = s.mime as AnnotationImageMime;
  const dims = imageSize(mime, buf);
  if (dims && (dims.width > ANNOTATION_IMAGE_MAX_SIDE || dims.height > ANNOTATION_IMAGE_MAX_SIDE)) {
    throw new AppError('VALIDATION_FAILED', `أبعاد الصورة أكبر من الحد (${ANNOTATION_IMAGE_MAX_SIDE} بكسل لكل ضلع).`, 400);
  }
  if (dims && (dims.width < 1 || dims.height < 1)) throw new AppError('VALIDATION_FAILED', 'أبعاد الصورة غير صالحة.', 400);

  const existing = getAnnotationImage(ctx, key);
  if (existing) {
    const file = ctx.files.stat(existing.file_id);
    const sameBytes = file ? file.size === buf.length && (await sameContent(ctx, existing.file_id, buf)) : false;
    if (!sameBytes) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لصورة أخرى على الخادم؛ لم يُكتب فوقها.', 409);
    return { image: toImageView(ctx, existing), duplicate: true };
  }
  const stored = await ctx.files.put(buf, { mime, originalName: name, maxBytes: ANNOTATION_IMAGE_MAX_BYTES });
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO annotation_image (image_key, file_id, mime, bytes, width, height, referenced, device_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_key) DO NOTHING`,
    [key, stored.id, mime, buf.length, dims?.width ?? null, dims?.height ?? null, annotationsUsing(ctx, key, false) > 0 ? 1 : 0, deviceId, now],
  );
  const row = getAnnotationImage(ctx, key)!;
  if (row.file_id !== stored.id) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لصورة أخرى على الخادم؛ لم يُكتب فوقها.', 409);
  return { image: toImageView(ctx, row), duplicate: false };
}

async function sameContent(ctx: AppContext, fileId: string, buf: Buffer): Promise<boolean> {
  try {
    const cur = await ctx.files.read(fileId);
    return Buffer.compare(Buffer.from(cur), buf) === 0;
  } catch {
    return false;
  }
}

/**
 * Remove pictures no annotation shows any more — neither live nor tombstoned (an undo or a sync «restore» brings a
 * tombstoned one back, so its picture stays). A picture that was never referenced is kept for a grace period: its
 * annotation may still be waiting in a device's outbox. Called after a permanent purge (sources module) and safe to
 * call any time. Returns the number of picture rows removed.
 */
export function pruneAnnotationImages(ctx: AppContext): number {
  const now = ctx.clock.now();
  const rows = ctx.db.all<AnnotationImageRow>('SELECT * FROM annotation_image');
  let removed = 0;
  const files = new Set<string>();
  for (const r of rows) {
    if (annotationsUsing(ctx, r.image_key, false) > 0) continue;
    if (r.referenced === 0 && now - r.created_at < UNREFERENCED_GRACE_MS) continue;
    ctx.db.run('DELETE FROM annotation_image WHERE image_key = ?', [r.image_key]);
    files.add(r.file_id);
    removed++;
  }
  for (const f of files) removeStoredFileIfUnreferenced(ctx, f);
  return removed;
}
