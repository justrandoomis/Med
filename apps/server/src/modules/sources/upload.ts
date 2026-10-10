// Upload inspection & registration (§13 upload part, §49 file validation).
//
//  * Type is decided from CONTENT (magic bytes) — never from the extension or the client's MIME.
//  * PDF: opened with pdfjs (password-protected / corrupt → rejected with a reason; page count recorded).
//  * ZIP: OOXML containers ([Content_Types].xml + word/ | ppt/) are DOCX/PPTX; any other ZIP is an image set
//    extracted with lib/safe-zip (traversal / bomb / entry limits), images kept in natural order, junk rejected.
//  * OLE2 (.doc/.ppt): accepted only when LibreOffice (soffice) exists to convert it.
//  * Audio: stored; transcription is not available in this version (stated, never faked).
//  * Duplicate content (sha256 of the uploaded bytes) is reported, never silently dropped or merged.
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  PROCESS_JOB_KIND,
  type JobView,
  type Pagination,
  type ProcessingSummary,
  type ProcessJobInput,
  type SourceFormat,
  type SourceType,
  type UploadFileResult,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { sha256File } from '../../lib/hash';
import { newId } from '../../lib/ids';
import { extractZipSafe, readZipEntryCount } from '../../lib/safe-zip';
import { contextOf } from '../library/service';
import { onSourceVersionChanged } from '../evidence/dependencies';
import { suggestSourceType } from './classify';
import { removeStoredFileIfUnreferenced } from './purge';
import { classifyOle, cleanFileName, IMAGE_MIMES, imageSize, naturalCompare, sniff, tiffSize, titleFromFileName, UNSUPPORTED_REASONS_AR, type SniffedImage } from './sniff';

export interface IncomingFile {
  tmpPath: string;
  fileName: string;
  size: number;
  /** the multipart size limit cut the stream */
  truncated: boolean;
}

type Detected = NonNullable<UploadFileResult['detected_format']>;

interface ImageEntry {
  path: string;
  filePath: string;
  mime: SniffedImage;
  size: number;
  width: number | null;
  height: number | null;
}

type Inspection =
  | { ok: false; detected: Detected; reason: string; rejected_entries?: UploadFileResult['rejected_entries'] }
  | {
      ok: true;
      detected: Detected;
      format: SourceFormat;
      pagination: Pagination;
      mime: string;
      pageCount: number | null;
      /** stored as original_file_id only (needs conversion before it can be rendered) */
      convertOnly?: boolean;
      /** single image dimensions */
      image?: { mime: SniffedImage; width: number | null; height: number | null };
      images?: ImageEntry[];
      rejected_entries?: UploadFileResult['rejected_entries'];
      note?: string;
      cleanupDir?: string;
    };

const MB = 1024 * 1024;
const PDF_OPEN_TIMEOUT_MS = 30_000;
const OFFICE_MAX_ENTRIES = 20_000;

// ───────── soffice detection (legacy .doc/.ppt conversion) ─────────
let sofficeCache: boolean | null = null;
/** LibreOffice on PATH (cached). MEDLEVO_SOFFICE_AVAILABLE=0|1 overrides detection (tests / deployments). */
export function sofficeAvailable(): boolean {
  if (sofficeCache !== null) return sofficeCache;
  const override = process.env.MEDLEVO_SOFFICE_AVAILABLE;
  if (override === '0' || override === '1') return (sofficeCache = override === '1');
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  sofficeCache = dirs.some((d) => existsSync(join(d, 'soffice')) || existsSync(join(d, 'libreoffice')));
  return sofficeCache;
}
/** test hook: force the detection result (null → detect again) */
export function setSofficeAvailableForTests(v: boolean | null): void {
  sofficeCache = v;
}

// ───────── inspection ─────────
async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Pixel size of an image file (header parsing only; TIFF reads its first IFD wherever it lies). */
async function imageSizeOf(path: string, mime: SniffedImage, head: Buffer): Promise<{ width: number; height: number } | null> {
  if (mime !== 'image/tiff') return imageSize(mime, head);
  const fh = await open(path, 'r');
  try {
    return await tiffSize(async (offset, length) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, 64 * 1024)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
}

type PdfCheck = { ok: true; pages: number | null; encrypted: boolean } | { ok: false; reason: string; code: 'password' | 'corrupt' };

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
async function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function inspectPdf(data: Buffer): Promise<PdfCheck> {
  const encrypted = /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(data.toString('latin1', Math.max(0, data.length - 64 * 1024))) || data.includes('/Encrypt');
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const doc = await Promise.race([
      task.promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PDF_OPEN_TIMEOUT_MS);
      }),
    ]);
    // a very slow (pathological) file is accepted without a page count; processing has its own limits
    return { ok: true, pages: doc ? doc.numPages : null, encrypted };
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') return { ok: false, code: 'password', reason: 'ملف PDF محمي بكلمة مرور. احفظ نسخة غير محمية منه ثم ارفعها.' };
    return { ok: false, code: 'corrupt', reason: 'تعذّر فتح ملف PDF: يبدو تالفًا أو غير مكتمل. جرّب تنزيله أو تصديره من جديد.' };
  } finally {
    if (timer) clearTimeout(timer);
    void task.destroy().catch(() => undefined);
  }
}

interface ZipListing {
  names: string[];
  declaredUncompressed: number;
  worstRatio: number;
}

async function listZip(data: Buffer): Promise<ZipListing | null> {
  try {
    const zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
    const files = Object.values(zip.files) as unknown as Array<{ name: string; dir: boolean; _data?: { compressedSize?: number; uncompressedSize?: number } }>;
    let total = 0;
    let worst = 0;
    for (const f of files) {
      if (f.dir) continue;
      const u = f._data?.uncompressedSize ?? 0;
      const c = Math.max(1, f._data?.compressedSize ?? 0);
      total += u;
      if (u > MB) worst = Math.max(worst, u / c);
    }
    return { names: files.filter((f) => !f.dir).map((f) => f.name), declaredUncompressed: total, worstRatio: worst };
  } catch {
    return null;
  }
}

async function inspectZip(ctx: AppContext, file: IncomingFile, data: Buffer): Promise<Inspection> {
  const limits = ctx.config.limits;
  const declared = readZipEntryCount(data);
  if (declared === null) return { ok: false, detected: 'zip', reason: 'الملف ليس أرشيف ZIP صالحًا (تالف أو غير مكتمل).' };
  if (declared > OFFICE_MAX_ENTRIES) {
    return { ok: false, detected: 'zip', reason: `الأرشيف يحتوي على ${declared} عنصرًا، وهذا أكثر من المسموح.` };
  }
  const listing = await listZip(data);
  if (!listing) return { ok: false, detected: 'zip', reason: 'تعذّر قراءة الأرشيف (تالف أو مشفّر أو صيغة غير مدعومة).' };
  const has = (n: string) => listing.names.includes(n);
  const hasPrefix = (p: string) => listing.names.some((n) => n.startsWith(p));
  const officeBombCheck = async (): Promise<string | null> => {
    if (listing.declaredUncompressed > limits.maxZipUncompressedBytes) return 'حجم المستند بعد فك الضغط يتجاوز الحد المسموح على الخادم.';
    if (listing.worstRatio > limits.maxZipRatio) return 'نسبة الضغط داخل المستند مرتفعة بشكل غير طبيعي (احتمال zip bomb) — رُفض.';
    // the sizes above are what the archive DECLARES; a hostile package can lie (G8). Inflate everything once under the
    // same limits, keeping nothing, so the parser never meets a part larger than allowed.
    const measured = await extractZipSafe(
      data,
      { maxEntries: OFFICE_MAX_ENTRIES, maxTotalBytes: limits.maxZipUncompressedBytes, maxEntryBytes: limits.maxZipUncompressedBytes, maxRatio: limits.maxZipRatio },
      { mode: 'measure' },
    );
    const codes = new Set(measured.rejected.map((r) => r.code));
    if (measured.abortCode === 'TOTAL_LIMIT' || codes.has('TOTAL_LIMIT') || codes.has('ENTRY_TOO_LARGE')) return 'حجم المستند بعد فك الضغط يتجاوز الحد المسموح على الخادم.';
    if (codes.has('RATIO_EXCEEDED')) return 'نسبة الضغط داخل المستند مرتفعة بشكل غير طبيعي (احتمال zip bomb) — رُفض.';
    if (measured.aborted || codes.has('ENCRYPTED_OR_CORRUPT')) return 'المستند تالف أو مشفّر: تعذّر فك ضغط أجزائه كما تصفها رؤوس الأرشيف.';
    return null;
  };
  if (has('[Content_Types].xml')) {
    if (hasPrefix('word/')) {
      if (!has('word/document.xml')) return { ok: false, detected: 'docx', reason: 'ملف Word تالف: لا يحتوي على نص المستند (word/document.xml).' };
      const bomb = await officeBombCheck();
      if (bomb) return { ok: false, detected: 'docx', reason: bomb };
      return { ok: true, detected: 'docx', format: 'docx', pagination: 'paragraphs', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pageCount: null };
    }
    if (hasPrefix('ppt/')) {
      if (!has('ppt/presentation.xml')) return { ok: false, detected: 'pptx', reason: 'ملف PowerPoint تالف: لا يحتوي على ملف العرض (ppt/presentation.xml).' };
      const bomb = await officeBombCheck();
      if (bomb) return { ok: false, detected: 'pptx', reason: bomb };
      const slides = listing.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
      return {
        ok: true,
        detected: 'pptx',
        format: 'pptx',
        pagination: 'slides',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        pageCount: slides,
      };
    }
    if (hasPrefix('xl/')) return { ok: false, detected: 'unknown', reason: 'ملفات Excel غير مدعومة كمصادر دراسة. احفظ الجدول بصيغة PDF إن احتجته.' };
    return { ok: false, detected: 'unknown', reason: 'مستند Office من نوع غير مدعوم. الصيغ المدعومة: DOCX و PPTX.' };
  }
  if (has('mimetype')) {
    return { ok: false, detected: 'unknown', reason: 'ملفات OpenDocument أو EPUB غير مدعومة حاليًا. صدّرها بصيغة PDF أو DOCX/PPTX ثم ارفعها.' };
  }
  if (declared > limits.maxZipEntries) {
    return { ok: false, detected: 'zip', reason: `الأرشيف يحتوي على ${declared} عنصرًا، والحد المسموح ${limits.maxZipEntries}.` };
  }
  // an ordered set of images
  const dir = mkdtempSync(join(ctx.config.tmpDir, 'zip-'));
  const res = await extractZipSafe(
    data,
    // one image may never be larger than a whole upload (also bounds memory while inflating)
    { maxEntries: limits.maxZipEntries, maxTotalBytes: limits.maxZipUncompressedBytes, maxEntryBytes: limits.maxUploadBytes, maxRatio: limits.maxZipRatio },
    { mode: 'dir', dir },
  );
  const rejected: NonNullable<UploadFileResult['rejected_entries']> = res.rejected.map((r) => ({ name: r.originalName, reason_ar: r.reason_ar }));
  if (res.aborted) {
    // An ordered image set is never stored truncated: a lecture missing its last slides would look
    // complete. The whole archive is rejected with the reason (and every entry that was skipped).
    rmSync(dir, { recursive: true, force: true });
    const reason =
      res.abortCode === 'TOTAL_LIMIT'
        ? `حجم الصور داخل الأرشيف بعد فك الضغط يتجاوز الحد المسموح (${Math.round(limits.maxZipUncompressedBytes / MB)} MB)، لذلك لم يُحفظ منه شيء. قسّم الصور على أكثر من ملف ZIP ثم ارفعها.`
        : (res.abortReasonAr ?? 'تعذّر استخراج الأرشيف.');
    return { ok: false, detected: 'zip', reason, rejected_entries: rejected };
  }
  const images: ImageEntry[] = [];
  for (const entry of res.accepted) {
    const head = await readHead(entry.filePath!, 256 * 1024);
    const s = sniff(head);
    if (s.kind === 'image') {
      const dim = await imageSizeOf(entry.filePath!, s.mime, head);
      images.push({ path: entry.path, filePath: entry.filePath!, mime: s.mime, size: entry.size, width: dim?.width ?? null, height: dim?.height ?? null });
    } else {
      const why = s.kind === 'unsupported' && s.what !== 'unknown' && s.what !== 'text' ? UNSUPPORTED_REASONS_AR[s.what] : null;
      rejected.push({
        name: entry.originalName,
        reason_ar: why ?? 'ليس صورة مدعومة (PNG أو JPEG أو WebP أو GIF أو TIFF). أرشيف ZIP مقبول للصور المرتبة فقط؛ ارفع المستندات منفصلة.',
      });
    }
  }
  if (images.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, detected: 'zip', reason: 'لا يحتوي الأرشيف على صور مدعومة. يُقبل ZIP لمجموعات الصور المرتبة فقط.', rejected_entries: rejected };
  }
  images.sort((a, b) => naturalCompare(a.path, b.path));
  return {
    ok: true,
    detected: 'zip',
    format: 'image_set',
    pagination: 'images',
    mime: 'application/zip',
    pageCount: images.length,
    images,
    rejected_entries: rejected,
    cleanupDir: dir,
  };
}

export async function inspectFile(ctx: AppContext, file: IncomingFile): Promise<Inspection> {
  const maxMb = Math.round(ctx.config.limits.maxUploadBytes / MB);
  if (file.truncated) return { ok: false, detected: 'unknown', reason: `الملف أكبر من الحد المسموح للرفع (${maxMb} MB).` };
  if (file.size === 0) return { ok: false, detected: 'unknown', reason: UNSUPPORTED_REASONS_AR.empty };
  const head = await readHead(file.tmpPath, 256 * 1024);
  const s = sniff(head);
  switch (s.kind) {
    case 'pdf': {
      const data = await readFile(file.tmpPath);
      const check = await inspectPdf(data);
      if (!check.ok) return { ok: false, detected: 'pdf', reason: check.reason };
      return {
        ok: true,
        detected: 'pdf',
        format: 'pdf',
        pagination: 'pages',
        mime: 'application/pdf',
        pageCount: check.pages,
        note: check.encrypted ? 'ملف PDF مقيّد بصلاحيات (بلا كلمة مرور للفتح)؛ قُبل لأنه قابل للقراءة.' : undefined,
      };
    }
    case 'zip':
      return inspectZip(ctx, file, await readFile(file.tmpPath));
    case 'ole2': {
      const kind = classifyOle(await readFile(file.tmpPath));
      if (kind === 'encrypted_ooxml') return { ok: false, detected: 'unknown', reason: 'مستند Office محمي بكلمة مرور. أزل الحماية ثم ارفعه.' };
      if (kind === 'xls') return { ok: false, detected: 'unknown', reason: 'ملفات Excel غير مدعومة كمصادر دراسة.' };
      if (kind === 'unknown') return { ok: false, detected: 'unknown', reason: 'ملف Office قديم من نوع غير معروف. احفظه بصيغة PDF أو DOCX/PPTX ثم ارفعه.' };
      const label = kind === 'doc' ? 'Word (.doc)' : 'PowerPoint (.ppt)';
      if (!sofficeAvailable()) {
        return {
          ok: false,
          detected: kind,
          reason: `ملفات ${label} القديمة تحتاج برنامج LibreOffice على الخادم لتحويلها، وهو غير مثبت. احفظ الملف بصيغة ${kind === 'doc' ? 'DOCX' : 'PPTX'} أو PDF ثم ارفعه.`,
        };
      }
      return {
        ok: true,
        detected: kind,
        format: 'pdf',
        pagination: kind === 'ppt' ? 'slides' : 'pages',
        mime: kind === 'doc' ? 'application/msword' : 'application/vnd.ms-powerpoint',
        pageCount: null,
        convertOnly: true,
        note: `ملف ${label} قديم؛ يُحفظ الأصل كما هو وتُنشأ منه نسخة PDF للعرض عبر LibreOffice أثناء المعالجة.`,
      };
    }
    case 'image': {
      const dim = await imageSizeOf(file.tmpPath, s.mime, head);
      return {
        ok: true,
        detected: 'image',
        format: 'image',
        pagination: 'images',
        mime: s.mime,
        pageCount: 1,
        image: { mime: s.mime, width: dim?.width ?? null, height: dim?.height ?? null },
      };
    }
    case 'audio':
      return { ok: true, detected: 'audio', format: 'audio', pagination: 'timestamps', mime: s.mime, pageCount: null };
    case 'unsupported':
      return { ok: false, detected: 'unknown', reason: UNSUPPORTED_REASONS_AR[s.what] };
  }
}

// ───────── duplicates ─────────
export interface DuplicateInfo {
  source_id: string;
  version_id: string;
  title: string;
  in_trash: boolean;
}

export function findDuplicate(ctx: AppContext, contentHash: string): DuplicateInfo | null {
  const row = ctx.db.get<{ source_id: string; version_id: string; title: string; deleted_at: number | null }>(
    `SELECT v.source_id, v.id AS version_id, s.title, s.deleted_at FROM source_version v JOIN source s ON s.id = v.source_id
     WHERE v.content_hash = ? ORDER BY s.deleted_at IS NOT NULL, v.created_at LIMIT 1`,
    [contentHash],
  );
  return row ? { source_id: row.source_id, version_id: row.version_id, title: row.title, in_trash: row.deleted_at !== null } : null;
}

// ───────── processing queue ─────────
export function processingRegistered(ctx: AppContext): boolean {
  return ctx.jobs.isRegistered(PROCESS_JOB_KIND);
}

/**
 * Enqueue processing of a version. Returns null when no processing handler is registered in this
 * build (the version stays 'pending'; it is enqueued on the next boot that has a handler).
 */
export function enqueueProcessing(ctx: AppContext, versionId: string, reason: NonNullable<ProcessJobInput['reason']>, pageIndexes?: number[]): JobView | null {
  if (!processingRegistered(ctx)) return null;
  const input: ProcessJobInput = { version_id: versionId, reason };
  if (pageIndexes && pageIndexes.length > 0) input.page_indexes = pageIndexes;
  const key = reason === 'reprocess' ? `${PROCESS_JOB_KIND}:${versionId}:reprocess:${newId(ctx.clock.now())}` : `${PROCESS_JOB_KIND}:${versionId}:${reason}`;
  return ctx.jobs.enqueue(PROCESS_JOB_KIND, input, { idempotencyKey: key });
}

export function initialSummary(ctx: AppContext, pageCount: number | null, job: JobView | null): ProcessingSummary {
  return {
    stage: 'queued',
    stage_label_ar: job ? 'في انتظار المعالجة' : 'لم تبدأ المعالجة: وحدة معالجة المستندات غير متاحة في هذا الإصدار من الخادم.',
    pages_total: pageCount,
    pages_ready: 0,
    pages_failed: 0,
    pages_needs_review: 0,
    pages_ocr: 0,
    failed_pages: [],
    coverage_complete: false,
    job_id: job?.id ?? null,
    updated_at: ctx.clock.now(),
  };
}

function audioSummary(ctx: AppContext): ProcessingSummary {
  return {
    stage: 'done',
    stage_label_ar: 'حُفظ التسجيل الصوتي. التفريغ النصي (transcription) غير متاح في هذا الإصدار، لذلك لا يمكن البحث فيه أو الاستشهاد به بعد.',
    pages_total: null,
    pages_ready: 0,
    pages_failed: 0,
    pages_needs_review: 0,
    pages_ocr: 0,
    failed_pages: [],
    coverage_complete: false,
    job_id: null,
    updated_at: ctx.clock.now(),
  };
}

// ───────── registration ─────────
interface StoredParts {
  fileId: string | null;
  originalFileId: string | null;
  pages: Array<{ fileId: string; path: string; width: number | null; height: number | null }>;
}

async function storeFiles(ctx: AppContext, file: IncomingFile, insp: Extract<Inspection, { ok: true }>): Promise<StoredParts> {
  const put = (path: string, mime: string, name: string) => ctx.files.put(createReadStream(path), { mime, originalName: name, maxBytes: ctx.config.limits.maxUploadBytes });
  if (insp.format === 'image_set') {
    const zip = await put(file.tmpPath, 'application/zip', file.fileName);
    const pages: StoredParts['pages'] = [];
    for (const img of insp.images ?? []) {
      const stored = await put(img.filePath, img.mime, img.path.split('/').pop() ?? img.path);
      pages.push({ fileId: stored.id, path: img.path, width: img.width, height: img.height });
    }
    return { fileId: null, originalFileId: zip.id, pages };
  }
  const stored = await put(file.tmpPath, insp.mime, file.fileName);
  if (insp.convertOnly) return { fileId: null, originalFileId: stored.id, pages: [] };
  if (insp.format === 'image') return { fileId: stored.id, originalFileId: null, pages: [{ fileId: stored.id, path: file.fileName, width: insp.image?.width ?? null, height: insp.image?.height ?? null }] };
  return { fileId: stored.id, originalFileId: null, pages: [] };
}

function storedIds(parts: StoredParts): string[] {
  return [...new Set([parts.fileId, parts.originalFileId, ...parts.pages.map((p) => p.fileId)].filter((x): x is string => !!x))];
}

function allStoredFilesExist(ctx: AppContext, parts: StoredParts): boolean {
  return storedIds(parts).every((id) => ctx.files.stat(id) !== null);
}

/**
 * Run the registration transaction. If it fails (e.g. the target was trashed during the upload), the
 * blobs this upload stored are removed again unless something else references them (deduplicated
 * content of another source stays) — a failed upload leaves nothing behind.
 */
function registerOrRollbackFiles(ctx: AppContext, parts: StoredParts, fn: () => void): void {
  try {
    ctx.db.tx(fn);
  } catch (e) {
    for (const id of storedIds(parts)) {
      try {
        removeStoredFileIfUnreferenced(ctx, id);
      } catch (cleanupErr) {
        ctx.log.warn({ err: cleanupErr, fileId: id }, 'could not remove the blob of a failed upload');
      }
    }
    throw e;
  }
}

export interface CreateSourceOptions {
  nodeId: string;
  sourceType?: SourceType;
  title?: string;
  onDuplicate: 'report' | 'create';
}

/** Insert the version's pages (images only — documents get pages from processing). */
function insertImagePages(ctx: AppContext, versionId: string, parts: StoredParts, now: number): void {
  parts.pages.forEach((p, i) => {
    ctx.db.run(
      `INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, render_file_id, section_key, created_at, updated_at)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`,
      [newId(now), versionId, i, p.width, p.height, p.width !== null ? 'px' : null, p.fileId, p.path, now, now],
    );
  });
}

/** Process ONE uploaded file into a new source (or a rejection / duplicate report). */
export async function registerUpload(ctx: AppContext, file: IncomingFile, opts: CreateSourceOptions): Promise<UploadFileResult> {
  const base: UploadFileResult = { file_name: file.fileName, status: 'rejected', size: file.size };
  const insp = await inspectFile(ctx, file);
  try {
    if (!insp.ok) return { ...base, detected_format: insp.detected, reason_ar: insp.reason, rejected_entries: insp.rejected_entries };
    const suggestion = suggestSourceType(file.fileName, insp.format);
    const result: UploadFileResult = {
      ...base,
      detected_format: insp.detected,
      suggested_source_type: suggestion.type,
      rejected_entries: insp.rejected_entries && insp.rejected_entries.length > 0 ? insp.rejected_entries : undefined,
    };
    const { sha256: contentHash } = await sha256File(file.tmpPath);
    const dup = findDuplicate(ctx, contentHash);
    if (dup && opts.onDuplicate !== 'create') {
      return {
        ...result,
        status: 'duplicate',
        duplicate_of: { source_id: dup.source_id, version_id: dup.version_id, title: dup.title },
        reason_ar: dup.in_trash
          ? `المحتوى نفسه موجود في مصدر داخل سلة المحذوفات: «${dup.title}». استعده بدل رفعه من جديد، أو أضفه كنسخة مستقلة.`
          : `المحتوى نفسه موجود بالفعل في «${dup.title}». لم يُنشأ مصدر جديد ولم يُحذف شيء.`,
      };
    }

    let parts = await storeFiles(ctx, file, insp);
    // a concurrent purge may have removed a deduplicated blob between put() and our insert
    if (!allStoredFilesExist(ctx, parts)) parts = await storeFiles(ctx, file, insp);

    const now = ctx.clock.now();
    const sourceId = newId(now);
    const versionId = newId(now);
    const ownerType = opts.sourceType !== undefined;
    const sourceType = opts.sourceType ?? suggestion.type;
    const title = opts.title?.trim() || titleFromFileName(file.fileName);
    const notes = [insp.note, dup ? `محتوى مطابق لمصدر موجود («${dup.title}»)؛ أُنشئ بطلب صريح منك.` : undefined].filter(Boolean).join(' ');
    registerOrRollbackFiles(ctx, parts, () => {
      const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [opts.nodeId]);
      if (!node || node.deleted_at !== null) {
        throw new AppError('CONFLICT', 'نُقل المجلد الهدف إلى سلة المحذوفات (أو حُذف) أثناء الرفع، فلم يُحفظ هذا الملف. اختر مجلدًا آخر ثم أعد المحاولة.', 409);
      }
      const c = contextOf(ctx, opts.nodeId);
      const order = (ctx.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM source WHERE node_id = ?', [opts.nodeId])?.m ?? 0) + 1024;
      ctx.db.run(
        `INSERT INTO source (id, title, source_type, source_type_origin, node_id, subject_node_id, course_node_id, metadata_status, processing_status,
           sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?)`,
        [sourceId, title, sourceType, ownerType ? 'owner' : 'auto', opts.nodeId, c.subject, c.course, insp.format === 'audio' ? 'partial' : 'pending', order, now, now],
      );
      ctx.db.run(
        `INSERT INTO source_version (id, source_id, version_no, kind, file_id, original_file_id, content_hash, mime, file_name, format, page_count, pagination,
           processing_status, note, created_at)
         VALUES (?, ?, 1, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, sourceId, parts.fileId, parts.originalFileId, contentHash, insp.mime, file.fileName, insp.format, insp.pageCount, insp.pagination, insp.format === 'audio' ? 'partial' : 'pending', notes || null, now],
      );
      ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
      insertImagePages(ctx, versionId, parts, now);
      ctx.audit.record({
        entityType: 'source',
        entityId: sourceId,
        action: 'create',
        summary: `رفع «${title}»`,
        after: { file_name: file.fileName, format: insp.format, source_type: sourceType, source_type_origin: ownerType ? 'owner' : 'auto', node_id: opts.nodeId, duplicate_of: dup?.source_id ?? null },
      });
    });
    finishProcessingSetup(ctx, versionId, insp.format, insp.pageCount, 'upload');
    return {
      ...result,
      status: 'accepted',
      source_id: sourceId,
      version_id: versionId,
      duplicate_of: dup ? { source_id: dup.source_id, version_id: dup.version_id, title: dup.title } : undefined,
      reason_ar: undefined,
    };
  } finally {
    if (insp.ok && insp.cleanupDir) rmSync(insp.cleanupDir, { recursive: true, force: true });
  }
}

/**
 * Versions uploaded while no processing handler existed (or whose enqueue failed) are queued as soon
 * as one does (called on server boot). Idempotency keys prevent duplicate jobs.
 */
export function enqueuePendingVersions(ctx: AppContext): number {
  if (!processingRegistered(ctx)) return 0;
  const pending = ctx.db.all<{ id: string; kind: string; page_count: number | null }>(
    `SELECT v.id, v.kind, v.page_count FROM source_version v JOIN source s ON s.id = v.source_id
     WHERE v.processing_status = 'pending' AND v.format <> 'audio' AND s.deleted_at IS NULL`,
  );
  let n = 0;
  for (const v of pending) {
    try {
      const job = enqueueProcessing(ctx, v.id, v.kind === 'replacement' ? 'replacement' : 'upload');
      ctx.db.run(
        `UPDATE source_version SET processing_summary_json = ? WHERE id = ?
           AND (processing_summary_json IS NULL OR json_extract(processing_summary_json, '$.job_id') IS NULL)`,
        [toJson(initialSummary(ctx, v.page_count, job)), v.id],
      );
      n++;
    } catch (e) {
      ctx.log.error({ err: e, versionId: v.id }, 'could not enqueue pending version');
    }
  }
  return n;
}

/** Enqueue processing (or record why it cannot run) and write the initial honest summary. */
export function finishProcessingSetup(ctx: AppContext, versionId: string, format: SourceFormat, pageCount: number | null, reason: 'upload' | 'replacement'): JobView | null {
  if (format === 'audio') {
    ctx.db.run('UPDATE source_version SET processing_summary_json = ? WHERE id = ?', [toJson(audioSummary(ctx)), versionId]);
    return null;
  }
  let job: JobView | null = null;
  try {
    job = enqueueProcessing(ctx, versionId, reason);
  } catch (e) {
    ctx.log.error({ err: e, versionId }, 'could not enqueue processing');
  }
  ctx.db.run('UPDATE source_version SET processing_summary_json = ? WHERE id = ? AND processing_summary_json IS NULL', [
    toJson(initialSummary(ctx, pageCount, job)),
    versionId,
  ]);
  return job;
}

/** Replacement upload → new version (kind 'replacement') of an existing source. */
export async function registerReplacement(ctx: AppContext, sourceId: string, file: IncomingFile, note: string | null): Promise<UploadFileResult> {
  const base: UploadFileResult = { file_name: file.fileName, status: 'rejected', size: file.size };
  const insp = await inspectFile(ctx, file);
  try {
    if (!insp.ok) return { ...base, detected_format: insp.detected, reason_ar: insp.reason, rejected_entries: insp.rejected_entries };
    const { sha256: contentHash } = await sha256File(file.tmpPath);
    const own = ctx.db.get<{ id: string; version_no: number }>('SELECT id, version_no FROM source_version WHERE source_id = ? AND content_hash = ?', [sourceId, contentHash]);
    const title = ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [sourceId])?.title ?? '';
    if (own) {
      return {
        ...base,
        status: 'duplicate',
        detected_format: insp.detected,
        duplicate_of: { source_id: sourceId, version_id: own.id, title },
        reason_ar: `هذا الملف مطابق للنسخة ${own.version_no} من هذا المصدر؛ لم تُنشأ نسخة جديدة.`,
      };
    }
    const other = findDuplicate(ctx, contentHash);
    let parts = await storeFiles(ctx, file, insp);
    if (!allStoredFilesExist(ctx, parts)) parts = await storeFiles(ctx, file, insp);
    const now = ctx.clock.now();
    const versionId = newId(now);
    registerOrRollbackFiles(ctx, parts, () => {
      const src = ctx.db.get<{ current_version_id: string | null; frozen_version_id: string | null; deleted_at: number | null; title: string }>(
        'SELECT current_version_id, frozen_version_id, deleted_at, title FROM source WHERE id = ?',
        [sourceId],
      );
      // the upload may take minutes: the source can be trashed or purged meanwhile
      if (!src || src.deleted_at !== null) {
        throw new AppError('CONFLICT', 'نُقل هذا المصدر إلى سلة المحذوفات (أو حُذف) أثناء الرفع، فلم تُحفظ النسخة الجديدة. استعده أولًا ثم أعد المحاولة.', 409);
      }
      const prev = src.current_version_id;
      const no = (ctx.db.get<{ m: number }>('SELECT MAX(version_no) AS m FROM source_version WHERE source_id = ?', [sourceId])?.m ?? 0) + 1;
      const fullNote = [note?.trim() || undefined, insp.note, other ? `محتوى مطابق لمصدر آخر («${other.title}»).` : undefined].filter(Boolean).join(' ');
      ctx.db.run(
        `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, original_file_id, content_hash, mime, file_name, format,
           page_count, pagination, processing_status, note, created_at)
         VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, sourceId, no, prev, parts.fileId, parts.originalFileId, contentHash, insp.mime, file.fileName, insp.format, insp.pageCount, insp.pagination, insp.format === 'audio' ? 'partial' : 'pending', fullNote || null, now],
      );
      ctx.db.run('UPDATE source SET current_version_id = ?, processing_status = ?, updated_at = ? WHERE id = ?', [versionId, insp.format === 'audio' ? 'partial' : 'pending', now, sourceId]);
      insertImagePages(ctx, versionId, parts, now);
      // content change alert (§18) through the evidence module's dependency service: per-dependent impact
      // (compared once the new version is processed), non-frozen artifacts marked stale, frozen ones kept
      // with a warning. The frozen version (Source Freeze) is untouched. See docs/modules/evidence-search.md.
      onSourceVersionChanged(ctx, { sourceId, fromVersionId: null, toVersionId: versionId, kind: 'source_replaced' });
      ctx.audit.record({
        entityType: 'source',
        entityId: sourceId,
        action: 'new_version',
        summary: `نسخة جديدة (${no}) من «${src.title}»`,
        before: { current_version_id: prev },
        after: { current_version_id: versionId, file_name: file.fileName, format: insp.format },
      });
    });
    finishProcessingSetup(ctx, versionId, insp.format, insp.pageCount, 'replacement');
    return { ...base, status: 'accepted', detected_format: insp.detected, source_id: sourceId, version_id: versionId, rejected_entries: insp.rejected_entries?.length ? insp.rejected_entries : undefined };
  } finally {
    if (insp.ok && insp.cleanupDir) rmSync(insp.cleanupDir, { recursive: true, force: true });
  }
}

export { cleanFileName, IMAGE_MIMES };
