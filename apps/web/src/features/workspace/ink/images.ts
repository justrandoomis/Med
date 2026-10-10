// Pictures placed on pages (§26 «Image» tool, track F1). Non-destructive: the picture is its own annotation
// (kind 'image') above the page and under the ink; the page itself is never changed.
//
// Local-first like ink (§47): inserting stores the picture in IndexedDB (`blobs`, id `annimg:<image_key>`) and the
// annotation through the ink store (row + outbox op in one transaction). The bytes are uploaded separately to
// POST /api/annotations/images by `image_key` — idempotent, retried until the server answers, and independent of the
// annotation's op order (the server accepts either first). A refused upload (type / size) is kept on the device and
// labelled with the server's reason; nothing is silently dropped.
import { useEffect, useState } from 'react';
import { ANNOTATION_IMAGE_MAX_BYTES, ANNOTATION_IMAGE_MAX_SIDE, ANNOTATION_IMAGE_MIMES, newId, type AnnotationAnchor, type AnnotationImageMime, type ImageAnnotationData, type NormBox } from '@medlevo/shared';
import { api, isApiError } from '../../../lib/api';
import { getDb, type BlobRecord, type MedLevoDB } from '../../../lib/localdb';
import { peekDeviceId } from '../../../lib/deviceId';
import { makeImageItem } from './model';
import type { InkDocumentStore } from './store';

export const IMAGE_BLOB_KIND = 'annotation_image';
export const imageBlobId = (key: string) => `annimg:${key}`;
export const imageUrl = (key: string) => `/api/annotations/images/${encodeURIComponent(key)}`;

/** Largest part of the page a newly inserted picture takes (it can be resized with the lasso). */
export const IMAGE_MAX_PAGE_FRACTION = 0.6;

export type ImageUploadState = 'pending' | 'uploaded' | 'rejected';

export interface ImageBlobRecord extends BlobRecord {
  imageKey: string;
  uploadState: ImageUploadState;
  /** server's reason for a refused upload */
  uploadError?: string | null;
  attempts?: number;
  nextAttemptAt?: number;
  name?: string | null;
}

// ───────── validation (the server checks the same limits on the content itself) ─────────
export type ImageCheck = { ok: true; mime: AnnotationImageMime } | { ok: false; reason: string };

export function checkImageFile(file: { type: string; size: number; name?: string }): ImageCheck {
  const mime = (file.type || '').toLowerCase() as AnnotationImageMime;
  if (!(ANNOTATION_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return { ok: false, reason: 'هذا الملف ليس صورة مدعومة. أدرج صورة PNG أو JPEG أو WebP أو GIF.' };
  }
  if (file.size <= 0) return { ok: false, reason: 'الملف فارغ.' };
  if (file.size > ANNOTATION_IMAGE_MAX_BYTES) return { ok: false, reason: 'الصورة أكبر من الحد المسموح (10 ميغابايت). صغّرها ثم أعد إدراجها.' };
  return { ok: true, mime };
}

export function checkImageSize(w: number, h: number): string | null {
  if (!(w >= 1 && h >= 1)) return 'تعذّر قراءة أبعاد الصورة؛ قد يكون الملف تالفًا.';
  if (w > ANNOTATION_IMAGE_MAX_SIDE || h > ANNOTATION_IMAGE_MAX_SIDE) return `أبعاد الصورة أكبر من الحد (${ANNOTATION_IMAGE_MAX_SIDE} بكسل لكل ضلع).`;
  return null;
}

// ───────── geometry ─────────
/**
 * Where a newly inserted picture goes: centred on `at` (normalized page point), as large as its own pixels allow at
 * 96 dpi but at most IMAGE_MAX_PAGE_FRACTION of the page in each direction, aspect ratio kept (in page units), and
 * moved inside the page. `ar` = page height / page width; `pageWidthPt` converts pixels to page units.
 */
export function imageBoxAt(at: [number, number], natural: { w: number; h: number }, ar: number, opts: { pageWidthPt?: number; maxFraction?: number } = {}): NormBox {
  const max = opts.maxFraction ?? IMAGE_MAX_PAGE_FRACTION;
  const pageW = opts.pageWidthPt ?? 595;
  const aspect = natural.h / natural.w; // height / width in pixels
  // natural size in page-width units (1 css px = 0.75 pt)
  let w = (natural.w * 0.75) / pageW;
  // keep within max fraction of the page width and of the page height (h in page-height units = w·aspect / ar)
  w = Math.min(w, max, (max * ar) / aspect);
  w = Math.max(w, 0.02);
  const h = (w * aspect) / ar;
  const x = Math.min(Math.max(0, at[0] - w / 2), Math.max(0, 1 - w));
  const y = Math.min(Math.max(0, at[1] - h / 2), Math.max(0, 1 - h));
  return { x, y, w, h };
}

/** Pixel size of a picture (browser decoders; injectable for tests). */
export type SizeReader = (blob: Blob) => Promise<{ w: number; h: number }>;

export const readImageSize: SizeReader = async (blob) => {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    const out = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
};

// ───────── insert ─────────
export interface InsertImageInput {
  store: InkDocumentStore;
  targetKey: string;
  anchor: AnnotationAnchor;
  file: Blob & { name?: string };
  /** normalized point the picture is centred on */
  at: [number, number];
  /** page height / width */
  ar: number;
  pageWidthPt?: number;
  db?: MedLevoDB;
  readSize?: SizeReader;
  alt?: string | null;
}

export type InsertImageResult = { ok: true; id: string; imageKey: string } | { ok: false; reason: string };

export async function insertImage(input: InsertImageInput): Promise<InsertImageResult> {
  const db = input.db ?? getDb();
  const file = input.file;
  const check = checkImageFile({ type: file.type, size: file.size, name: file.name });
  if (!check.ok) return check;
  let size: { w: number; h: number };
  try {
    size = await (input.readSize ?? readImageSize)(file);
  } catch {
    return { ok: false, reason: 'تعذّر فتح الصورة؛ قد يكون الملف تالفًا أو بصيغة لا يعرضها هذا المتصفح.' };
  }
  const bad = checkImageSize(size.w, size.h);
  if (bad) return { ok: false, reason: bad };
  const imageKey = newId();
  const name = typeof file.name === 'string' && file.name ? file.name.slice(0, 255) : null;
  const rec: ImageBlobRecord = {
    id: imageBlobId(imageKey),
    imageKey,
    kind: IMAGE_BLOB_KIND,
    mime: check.mime,
    size: file.size,
    data: file,
    storedAt: Date.now(),
    uploadState: 'pending',
    uploadError: null,
    attempts: 0,
    nextAttemptAt: 0,
    name,
  };
  try {
    // the picture is on this device before the annotation exists: the page never points at bytes it does not have
    await db.blobs.put(rec);
  } catch {
    return { ok: false, reason: 'تعذّر حفظ الصورة على هذا الجهاز (مساحة التخزين ممتلئة أو محجوبة).' };
  }
  const data: ImageAnnotationData = {
    v: 1,
    image_key: imageKey,
    box: imageBoxAt(input.at, size, input.ar, { pageWidthPt: input.pageWidthPt }),
    mime: check.mime,
    natural_w: Math.round(size.w),
    natural_h: Math.round(size.h),
    bytes: file.size,
    alt: input.alt?.trim() || null,
    name,
  };
  const item = makeImageItem({ id: newId(), anchor: input.anchor, now: Date.now(), z: input.store.nextZ(input.targetKey), data });
  input.store.commit('إدراج صورة', [{ id: item.id, targetKey: input.targetKey, before: null, after: item }]);
  void kickImageUploads(db);
  return { ok: true, id: item.id, imageKey };
}

// ───────── uploads (idempotent by key; retried with backoff while online) ─────────
const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000];
/** HTTP answers that judge the picture itself (POST /api/annotations/images): kept on the device, labelled, not retried. */
const FINAL_UPLOAD_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 415, 422]);
let running: Promise<{ uploaded: number; rejected: number; failed: number }> | null = null;
const listeners = new Set<() => void>();

export function onImageUploadsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function pendingImageUploads(db: MedLevoDB = getDb()): Promise<ImageBlobRecord[]> {
  const rows = (await db.blobs.where('kind').equals(IMAGE_BLOB_KIND).toArray()) as ImageBlobRecord[];
  return rows.filter((r) => r.uploadState === 'pending');
}

export interface UploadDeps {
  /** POST the multipart body; resolves with the HTTP outcome (tests inject a fake) */
  post?: (form: FormData) => Promise<void>;
  now?: () => number;
  online?: () => boolean;
}

/** Upload every due pending picture once. Concurrent calls share one run. */
export function kickImageUploads(db: MedLevoDB = getDb(), deps: UploadDeps = {}): Promise<{ uploaded: number; rejected: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    const out = { uploaded: 0, rejected: 0, failed: 0 };
    const online = deps.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    if (!online()) return out;
    const now = deps.now ?? Date.now;
    const post = deps.post ?? ((form: FormData) => api.post('/annotations/images', form, { timeoutMs: 120_000, skipAuthRedirect: true }).then(() => undefined));
    for (const rec of await pendingImageUploads(db)) {
      if ((rec.nextAttemptAt ?? 0) > now()) continue;
      if (!(rec.data instanceof Blob)) {
        // the browser lost the bytes (storage cleared under it): say so, never upload garbage
        await db.blobs.update(rec.id, { uploadState: 'rejected', uploadError: 'لم تعد الصورة محفوظة كاملة على هذا الجهاز.' } as Partial<ImageBlobRecord>);
        out.rejected++;
        continue;
      }
      const form = new FormData();
      form.append('image_key', rec.imageKey);
      const device = peekDeviceId();
      if (device) form.append('device_id', device);
      form.append('file', rec.data, rec.name ?? `image-${rec.imageKey}`);
      try {
        await post(form);
        await db.blobs.update(rec.id, { uploadState: 'uploaded', uploadError: null } as Partial<ImageBlobRecord>);
        out.uploaded++;
      } catch (e) {
        const status = isApiError(e) ? e.status : 0;
        // only the server's verdict on THESE bytes is final (invalid key / type / size, a different picture under
        // the key); anything else (a refused origin, a proxy's 404, a server error …) is retried with backoff
        if (isApiError(e) && !e.offline && FINAL_UPLOAD_STATUSES.has(status)) {
          // the server will never accept these bytes (type / size / key clash): keep them, say why
          await db.blobs.update(rec.id, { uploadState: 'rejected', uploadError: e.message } as Partial<ImageBlobRecord>);
          out.rejected++;
        } else {
          const attempts = (rec.attempts ?? 0) + 1;
          await db.blobs.update(rec.id, { attempts, nextAttemptAt: now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]! } as Partial<ImageBlobRecord>);
          out.failed++;
          if (isApiError(e) && (e.offline || status === 401)) break; // no connection / signed out: try later
        }
      }
    }
    return out;
  })().finally(() => {
    running = null;
    listeners.forEach((l) => l());
  });
  return running;
}

let started = false;
/** Retry pending uploads when the device comes online and every minute while the app is open. */
export function startImageUploader(db: MedLevoDB = getDb()): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const kick = () => void kickImageUploads(db);
  window.addEventListener('online', kick);
  window.setInterval(kick, 60_000);
  kick();
}

// ───────── display ─────────
export interface ImageSrcState {
  src: string | null;
  /** this device holds the picture but has not uploaded it yet / the server refused it */
  upload: ImageUploadState | null;
  uploadError: string | null;
}

/**
 * The picture's source: this device's copy (object URL) when it has one, else the authenticated server route.
 * Also reports this device's upload state for an honest badge («بانتظار الرفع» / «رُفضت»).
 */
export function useImageSource(imageKey: string, db: MedLevoDB = getDb()): ImageSrcState {
  const [state, setState] = useState<ImageSrcState>({ src: null, upload: null, uploadError: null });
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const load = async () => {
      let rec: ImageBlobRecord | undefined;
      try {
        rec = (await db.blobs.get(imageBlobId(imageKey))) as ImageBlobRecord | undefined;
      } catch {
        rec = undefined;
      }
      if (cancelled) return;
      if (rec?.data instanceof Blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        if (!url) url = URL.createObjectURL(rec.data);
        setState({ src: url, upload: rec.uploadState ?? null, uploadError: rec.uploadError ?? null });
      } else {
        setState({ src: imageUrl(imageKey), upload: null, uploadError: null });
      }
    };
    void load();
    const off = onImageUploadsChanged(() => void load());
    return () => {
      cancelled = true;
      off();
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey, db]);
  return state;
}
