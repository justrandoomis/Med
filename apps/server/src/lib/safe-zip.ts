// Safe ZIP extraction (§13, §49). Defends against:
//  * path traversal / absolute paths / drive letters / control characters (entry rejected, never re-rooted)
//  * symlink entries (ignored)
//  * too many entries (checked from the End Of Central Directory BEFORE parsing the archive)
//  * zip bombs: total and per-entry uncompressed size and per-entry inflate ratio are MEASURED while
//    inflating (headers are not trusted); extraction stops as soon as a limit is crossed
//  * nested archives (reported, not extracted)
// Returns accepted + rejected entries with Arabic reasons. Office documents (docx/pptx/xlsx) are
// ZIP containers but are documents, not nested archives.
import { closeSync, constants as fsc, mkdirSync, openSync, writeSync, fsyncSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import JSZip from 'jszip';

export interface SafeZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  /** default: maxTotalBytes */
  maxEntryBytes?: number;
  /** uncompressed/compressed ratio allowed per entry (measured) */
  maxRatio: number;
  /** ratio is only enforced once an entry has inflated beyond this many bytes (default 1 MiB) */
  ratioMinBytes?: number;
}

export type SafeZipTarget = { mode: 'memory' } | { mode: 'dir'; dir: string };

export interface AcceptedZipEntry {
  /** normalized relative path (forward slashes, NFC) */
  path: string;
  originalName: string;
  size: number;
  compressedSize: number;
  /** memory mode */
  data?: Buffer;
  /** dir mode: absolute path of the written file */
  filePath?: string;
}

export type ZipRejectCode =
  | 'PATH_TRAVERSAL'
  | 'ABSOLUTE_PATH'
  | 'INVALID_NAME'
  | 'SYMLINK'
  | 'NESTED_ARCHIVE'
  | 'SYSTEM_FILE'
  | 'DUPLICATE_NAME'
  | 'ENTRY_TOO_LARGE'
  | 'RATIO_EXCEEDED'
  | 'TOTAL_LIMIT'
  | 'NOT_EXTRACTED'
  | 'ENCRYPTED_OR_CORRUPT';

export interface RejectedZipEntry {
  originalName: string;
  code: ZipRejectCode;
  reason_ar: string;
}

export interface SafeZipResult {
  accepted: AcceptedZipEntry[];
  rejected: RejectedZipEntry[];
  /** true when extraction stopped early because the archive as a whole is unsafe/invalid */
  aborted: boolean;
  abortCode?: 'ZIP_INVALID' | 'TOO_MANY_ENTRIES' | 'TOTAL_LIMIT';
  abortReasonAr?: string;
  totalUncompressed: number;
}

const REASONS_AR: Record<ZipRejectCode, string> = {
  PATH_TRAVERSAL: 'اسم الملف يحاول الخروج من مجلد الأرشيف (../) — رُفض لأسباب أمنية.',
  ABSOLUTE_PATH: 'اسم الملف مسار مطلق — رُفض لأسباب أمنية.',
  INVALID_NAME: 'اسم الملف غير صالح (رموز تحكم أو طول زائد).',
  SYMLINK: 'رابط رمزي (symlink) — تم تجاهله.',
  NESTED_ARCHIVE: 'أرشيف داخل الأرشيف — لا يُستخرج تلقائيًا. ارفعه منفصلًا إذا احتجته.',
  SYSTEM_FILE: 'ملف نظام مخفي — تم تجاهله.',
  DUPLICATE_NAME: 'اسم مكرر داخل الأرشيف — تم الاحتفاظ بالنسخة الأولى فقط.',
  ENTRY_TOO_LARGE: 'حجم الملف بعد فك الضغط يتجاوز الحد المسموح.',
  RATIO_EXCEEDED: 'نسبة الضغط مرتفعة بشكل غير طبيعي (احتمال zip bomb) — رُفض.',
  TOTAL_LIMIT: 'تجاوز الأرشيف الحجم الكلي المسموح بعد فك الضغط — توقف الاستخراج.',
  NOT_EXTRACTED: 'لم يُستخرج لأن الاستخراج توقف قبل الوصول إليه.',
  ENCRYPTED_OR_CORRUPT: 'تعذر فك ضغط الملف (مشفّر أو تالف).',
};

const NESTED_ARCHIVE_EXT = /\.(zip|zipx|rar|7z|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|lz|lzma|cab|iso|dmg|jar|war|apk|ipa)$/i;
const SYSTEM_FILE_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const MAGIC_ARCHIVE: Array<number[]> = [
  [0x52, 0x61, 0x72, 0x21], // Rar!
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a], // xz
];
const OFFICE_ZIP_EXT = /\.(docx|pptx|xlsx|docm|pptm|xlsm|odt|odp|ods|epub)$/i;

function startsWith(buf: Uint8Array, magic: number[]): boolean {
  if (buf.length < magic.length) return false;
  return magic.every((b, i) => buf[i] === b);
}

function looksLikeArchive(name: string, head: Uint8Array): boolean {
  if (NESTED_ARCHIVE_EXT.test(name)) return true;
  if (OFFICE_ZIP_EXT.test(name)) return false;
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return true; // a ZIP not named as an office document
  return MAGIC_ARCHIVE.some((m) => startsWith(head, m));
}

/** Normalize an entry name or return a reject code. Never "fixes" traversal by re-rooting. */
export function normalizeEntryName(name: string): { path: string } | { code: ZipRejectCode } {
  if (CONTROL_RE.test(name)) return { code: 'INVALID_NAME' };
  let n = name.normalize('NFC').replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.startsWith('//')) return { code: 'ABSOLUTE_PATH' };
  const segments: string[] = [];
  for (const seg of n.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { code: 'PATH_TRAVERSAL' };
    if (Buffer.byteLength(seg) > 255) return { code: 'INVALID_NAME' };
    segments.push(WINDOWS_RESERVED.test(seg) ? `_${seg}` : seg.replace(/[. ]+$/, '') || '_');
  }
  if (segments.length === 0) return { code: 'INVALID_NAME' };
  n = segments.join('/');
  if (Buffer.byteLength(n) > 1024) return { code: 'INVALID_NAME' };
  return { path: n };
}

/** Read the total entry count from the End Of Central Directory (zip64 aware). null → not a ZIP. */
export function readZipEntryCount(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const total = buf.readUInt16LE(i + 10);
    if (total !== 0xffff) return total;
    // zip64: locator sits right before the EOCD
    const loc = i - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const eocd64 = Number(buf.readBigUInt64LE(loc + 8));
      if (eocd64 >= 0 && eocd64 + 56 <= buf.length && buf.readUInt32LE(eocd64) === 0x06064b50) {
        return Number(buf.readBigUInt64LE(eocd64 + 32));
      }
    }
    return total;
  }
  return null;
}

interface InternalZipObject {
  name: string;
  dir: boolean;
  unixPermissions?: number | null;
  unsafeOriginalName?: string;
  _data?: { compressedSize?: number; uncompressedSize?: number };
  internalStream(type: 'uint8array'): {
    on(ev: 'data', fn: (chunk: Uint8Array) => void): unknown;
    on(ev: 'error', fn: (e: Error) => void): unknown;
    on(ev: 'end', fn: () => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
}

type InflateOutcome = { ok: true; data: Buffer } | { ok: false; code: ZipRejectCode };

function inflateEntry(
  entry: InternalZipObject,
  compressedSize: number,
  budget: { remaining: number },
  limits: Required<SafeZipLimits>,
): Promise<InflateOutcome> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const helper = entry.internalStream('uint8array');
    const finish = (o: InflateOutcome) => {
      if (done) return;
      done = true;
      if (!o.ok) {
        try {
          helper.pause();
        } catch {
          /* ignore */
        }
      }
      resolveP(o);
    };
    helper.on('data', (chunk: Uint8Array) => {
      if (done) return;
      size += chunk.length;
      if (size > budget.remaining) return finish({ ok: false, code: 'TOTAL_LIMIT' });
      if (size > limits.maxEntryBytes) return finish({ ok: false, code: 'ENTRY_TOO_LARGE' });
      if (size > limits.ratioMinBytes && size / Math.max(1, compressedSize) > limits.maxRatio) {
        return finish({ ok: false, code: 'RATIO_EXCEEDED' });
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    helper.on('error', () => finish({ ok: false, code: 'ENCRYPTED_OR_CORRUPT' }));
    helper.on('end', () => finish({ ok: true, data: Buffer.concat(chunks, size) }));
    helper.resume();
  });
}

function writeInside(root: string, relPath: string, data: Buffer): string {
  const target = resolve(root, ...relPath.split('/'));
  if (!target.startsWith(root + sep)) throw new Error('path escapes extraction root');
  mkdirSync(dirname(target), { recursive: true });
  // the parent chain was created by us inside a fresh temp dir; re-check after mkdir (no symlinks)
  if (!realpathSync(dirname(target)).startsWith(root)) throw new Error('path escapes extraction root');
  const fd = openSync(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return target;
}

export async function extractZipSafe(input: Buffer, limitsIn: SafeZipLimits, target: SafeZipTarget = { mode: 'memory' }): Promise<SafeZipResult> {
  const limits: Required<SafeZipLimits> = {
    maxEntries: limitsIn.maxEntries,
    maxTotalBytes: limitsIn.maxTotalBytes,
    maxEntryBytes: limitsIn.maxEntryBytes ?? limitsIn.maxTotalBytes,
    maxRatio: limitsIn.maxRatio,
    ratioMinBytes: limitsIn.ratioMinBytes ?? 1024 * 1024,
  };
  const result: SafeZipResult = { accepted: [], rejected: [], aborted: false, totalUncompressed: 0 };
  const reject = (originalName: string, code: ZipRejectCode) => result.rejected.push({ originalName, code, reason_ar: REASONS_AR[code] });

  const declared = readZipEntryCount(input);
  if (declared === null) {
    return { ...result, aborted: true, abortCode: 'ZIP_INVALID', abortReasonAr: 'الملف ليس أرشيف ZIP صالحًا.' };
  }
  if (declared > limits.maxEntries) {
    return {
      ...result,
      aborted: true,
      abortCode: 'TOO_MANY_ENTRIES',
      abortReasonAr: `الأرشيف يحتوي على ${declared} عنصرًا، والحد المسموح ${limits.maxEntries}.`,
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input, { checkCRC32: false, createFolders: false });
  } catch {
    return { ...result, aborted: true, abortCode: 'ZIP_INVALID', abortReasonAr: 'تعذر قراءة الأرشيف (تالف أو مشفّر أو صيغة غير مدعومة).' };
  }

  const entries = Object.values(zip.files as unknown as Record<string, InternalZipObject>).filter((e) => !e.dir);
  if (entries.length > limits.maxEntries) {
    return {
      ...result,
      aborted: true,
      abortCode: 'TOO_MANY_ENTRIES',
      abortReasonAr: `الأرشيف يحتوي على ${entries.length} ملفًا، والحد المسموح ${limits.maxEntries}.`,
    };
  }

  let root: string | null = null;
  if (target.mode === 'dir') {
    mkdirSync(target.dir, { recursive: true });
    root = realpathSync(target.dir);
  }

  const seen = new Set<string>();
  const budget = { remaining: limits.maxTotalBytes };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (result.aborted) {
      reject(originalName, 'NOT_EXTRACTED');
      continue;
    }
    const perms = entry.unixPermissions ?? 0;
    if ((perms & 0o170000) === 0o120000) {
      reject(originalName, 'SYMLINK');
      continue;
    }
    const norm = normalizeEntryName(originalName);
    if ('code' in norm) {
      reject(originalName, norm.code);
      continue;
    }
    if (SYSTEM_FILE_RE.test(norm.path)) {
      reject(originalName, 'SYSTEM_FILE');
      continue;
    }
    const key = norm.path.toLowerCase();
    if (seen.has(key)) {
      reject(originalName, 'DUPLICATE_NAME');
      continue;
    }
    seen.add(key);
    if (NESTED_ARCHIVE_EXT.test(norm.path)) {
      reject(originalName, 'NESTED_ARCHIVE');
      continue;
    }
    const compressedSize = entry._data?.compressedSize ?? 0;
    const out = await inflateEntry(entry, compressedSize, budget, limits);
    if (!out.ok) {
      reject(originalName, out.code);
      if (out.code === 'TOTAL_LIMIT') {
        result.aborted = true;
        result.abortCode = 'TOTAL_LIMIT';
        result.abortReasonAr = REASONS_AR.TOTAL_LIMIT;
      }
      continue;
    }
    if (looksLikeArchive(norm.path, out.data.subarray(0, 8))) {
      reject(originalName, 'NESTED_ARCHIVE');
      continue;
    }
    budget.remaining -= out.data.length;
    result.totalUncompressed += out.data.length;
    const accepted: AcceptedZipEntry = { path: norm.path, originalName, size: out.data.length, compressedSize };
    if (root) {
      try {
        accepted.filePath = writeInside(root, norm.path, out.data);
      } catch {
        reject(originalName, 'INVALID_NAME');
        continue;
      }
    } else {
      accepted.data = out.data;
    }
    result.accepted.push(accepted);
  }
  return result;
}
