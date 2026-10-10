// Backup archive format: a gzip-compressed POSIX ustar archive (`.tar.gz`), readable with standard tools
// (`tar -tzf medlevo-backup-….tar.gz`). Written and read as STREAMS so a large library never has to fit in memory.
//
// Writer: regular files only, mode 0600, names validated with the same rules as safe ZIP extraction
// (lib/safe-zip.ts `normalizeEntryName`: no traversal, no absolute paths, no control characters), sizes ≥ 8 GiB
// in GNU base-256. A file that changes size while it is archived fails the entry (never a silent truncation).
//
// Reader (`extractTarGz`) — used ONLY to restore/verify into a fresh directory:
//  * header checksums are verified; only regular files and directories are accepted (symlinks, hard links,
//    devices, FIFOs, pax/GNU extension headers → the whole archive is refused)
//  * entry names: traversal / absolute / drive / control characters / duplicates (case-insensitive) → refused,
//    never re-rooted; every file is written O_EXCL|O_NOFOLLOW 0600 strictly inside the target directory
//  * limits are MEASURED while inflating (headers are not trusted): entry count, per-entry and total
//    uncompressed bytes, and the overall inflate ratio (zip-bomb guard, same idea as lib/safe-zip.ts)
//  * a truncated archive (missing end-of-archive blocks or data) is refused
import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants as fsc, createReadStream, createWriteStream, fstatSync, fsyncSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve, sep } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { normalizeEntryName } from '../../lib/safe-zip';

const BLOCK = 512;
const OCTAL_SIZE_MAX = 8 ** 11 - 1;

export class ArchiveError extends Error {
  constructor(
    readonly code:
      | 'INVALID_NAME'
      | 'UNSUPPORTED_ENTRY'
      | 'BAD_HEADER'
      | 'DUPLICATE_NAME'
      | 'TOO_MANY_ENTRIES'
      | 'ENTRY_TOO_LARGE'
      | 'TOTAL_LIMIT'
      | 'RATIO_EXCEEDED'
      | 'TRUNCATED'
      | 'NOT_GZIP'
      | 'SIZE_CHANGED'
      | 'WRITE_FAILED',
    readonly reasonAr: string,
  ) {
    super(`${code}: ${reasonAr}`);
    this.name = 'ArchiveError';
  }
}

/** Validates an archive entry name (same rules as the safe ZIP extractor). Returns the normalized path. */
export function safeEntryName(name: string): string {
  const n = normalizeEntryName(name);
  if ('code' in n) throw new ArchiveError('INVALID_NAME', `اسم عنصر غير آمن داخل الأرشيف (${n.code}) — رُفض الأرشيف كاملًا.`);
  return n.path;
}

function octal(value: number, width: number): string {
  // width includes the trailing NUL
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeSizeField(h: Buffer, size: number): void {
  if (size <= OCTAL_SIZE_MAX) {
    h.write(octal(size, 12), 124, 12, 'ascii');
    return;
  }
  // GNU base-256: high bit set, big-endian value in the remaining 11 bytes
  h.fill(0, 124, 136);
  h[124] = 0x80;
  let v = BigInt(size);
  for (let i = 135; i > 124; i--) {
    h[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readSizeField(h: Buffer): number {
  if ((h[124]! & 0x80) !== 0) {
    let v = 0n;
    for (let i = 125; i < 136; i++) v = (v << 8n) | BigInt(h[i]!);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError('BAD_HEADER', 'حجم عنصر في الأرشيف غير معقول.');
    return Number(v);
  }
  return parseOctal(h.subarray(124, 136));
}

function parseOctal(field: Buffer): number {
  const s = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError('BAD_HEADER', 'ترويسة عنصر في الأرشيف تالفة.');
  return parseInt(s, 8);
}

function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new ArchiveError('INVALID_NAME', 'اسم عنصر أطول من المسموح في صيغة الأرشيف.');
}

function checksum(h: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum;
}

export function tarHeader(path: string, size: number, mtimeMs: number, type: 'file' | 'dir' = 'file'): Buffer {
  const { name, prefix } = splitName(path);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(type === 'dir' ? 0o700 : 0o600, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  writeSizeField(h, type === 'dir' ? 0 : size);
  h.write(octal(Math.max(0, Math.floor(mtimeMs / 1000)), 12), 136, 12, 'ascii');
  h[156] = (type === 'dir' ? '5' : '0').charCodeAt(0);
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('medlevo', 265, 32, 'ascii');
  h.write('medlevo', 297, 32, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  const sum = checksum(h);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

export interface WrittenEntry {
  path: string;
  size: number;
  sha256: string;
}

/** Streaming `.tar.gz` writer. The output file is created exclusively (0600) — an existing file is never overwritten. */
export class TarGzWriter {
  private readonly tar = new PassThrough();
  private readonly done: Promise<void>;
  private failed: Error | null = null;
  private readonly archiveHash = createHash('sha256');
  private archiveBytes = 0;
  private readonly names = new Set<string>();
  private finished = false;

  constructor(readonly outPath: string) {
    const out = createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        this.archiveHash.update(chunk);
        this.archiveBytes += chunk.length;
        cb(null, chunk);
      },
    });
    this.done = pipeline(this.tar, createGzip({ level: 6 }), meter, out);
    this.done.catch((e: unknown) => {
      this.failed = e instanceof Error ? e : new Error(String(e));
      this.tar.emit('drain');
    });
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.failed) throw new ArchiveError('WRITE_FAILED', 'تعذّرت كتابة ملف النسخة الاحتياطية (المساحة أو الصلاحيات).');
    if (!this.tar.write(buf)) await once(this.tar, 'drain');
    if (this.failed) throw new ArchiveError('WRITE_FAILED', 'تعذّرت كتابة ملف النسخة الاحتياطية (المساحة أو الصلاحيات).');
  }

  private claim(path: string): string {
    const p = safeEntryName(path);
    const key = p.toLowerCase();
    if (this.names.has(key)) throw new ArchiveError('DUPLICATE_NAME', 'عنصر مكرر في الأرشيف.');
    this.names.add(key);
    return p;
  }

  async addBuffer(path: string, data: Buffer, mtimeMs = Date.now()): Promise<WrittenEntry> {
    const p = this.claim(path);
    await this.write(tarHeader(p, data.length, mtimeMs));
    await this.write(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) await this.write(Buffer.alloc(pad, 0));
    return { path: p, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  /**
   * Adds a regular file by path. Symlinks are refused (O_NOFOLLOW); the size is taken from the open descriptor and
   * must not change while the file is read.
   */
  async addFile(path: string, sourcePath: string, mtimeMs?: number): Promise<WrittenEntry> {
    const p = this.claim(path);
    const fd = openSync(sourcePath, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    let closed = false;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new ArchiveError('UNSUPPORTED_ENTRY', 'ليس ملفًا عاديًا.');
      const size = st.size;
      await this.write(tarHeader(p, size, mtimeMs ?? st.mtimeMs));
      const hash = createHash('sha256');
      let read = 0;
      const stream = createReadStream('', { fd, autoClose: true });
      closed = true; // the stream owns the descriptor now
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        read += chunk.length;
        if (read > size) {
          stream.destroy();
          throw new ArchiveError('SIZE_CHANGED', 'تغيّر حجم ملف أثناء نسخه.');
        }
        hash.update(chunk);
        await this.write(chunk);
      }
      if (read !== size) throw new ArchiveError('SIZE_CHANGED', 'تغيّر حجم ملف أثناء نسخه.');
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad) await this.write(Buffer.alloc(pad, 0));
      return { path: p, size, sha256: hash.digest('hex') };
    } finally {
      if (!closed) closeSync(fd);
    }
  }

  /** Writes the end-of-archive blocks, flushes and fsyncs. Returns the archive's own size and sha256. */
  async finish(): Promise<{ size: number; sha256: string }> {
    if (this.finished) throw new Error('archive already finished');
    this.finished = true;
    await this.write(Buffer.alloc(BLOCK * 2, 0));
    this.tar.end();
    await this.done;
    const fd = openSync(this.outPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { size: this.archiveBytes, sha256: this.archiveHash.digest('hex') };
  }

  /** Stops writing and removes the partial file. */
  async abort(): Promise<void> {
    this.finished = true;
    this.tar.destroy();
    await this.done.catch(() => undefined);
    rmSync(this.outPath, { force: true });
  }
}

export interface TarExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  /** max uncompressed / compressed ratio over the whole stream (measured) */
  maxRatio: number;
  /** the ratio is enforced once this many bytes were inflated (default 8 MiB) */
  ratioMinBytes?: number;
}

export interface ExtractedEntry {
  /** normalized path inside the archive */
  path: string;
  size: number;
  sha256: string;
  /** absolute path of the written file */
  absPath: string;
}

export interface ExtractResult {
  entries: ExtractedEntry[];
  compressedBytes: number;
  inflatedBytes: number;
}

interface DataState {
  kind: 'data';
  remaining: number;
  pad: number;
  fd: number;
  hash: Hash;
  entry: ExtractedEntry;
}
type State = { kind: 'header' } | DataState | { kind: 'pad'; remaining: number };

function writeTargetInside(root: string, relPath: string): string {
  const target = resolve(root, ...relPath.split('/'));
  if (!target.startsWith(root + sep)) throw new ArchiveError('INVALID_NAME', 'عنصر يحاول الخروج من مجلد الاستعادة — رُفض الأرشيف.');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  if (realParent !== root && !realParent.startsWith(root + sep)) throw new ArchiveError('INVALID_NAME', 'عنصر يحاول الخروج من مجلد الاستعادة — رُفض الأرشيف.');
  return target;
}

/**
 * Extracts a `.tar.gz` into `destDir` (created if missing; should be a fresh, empty directory). Throws
 * ArchiveError (Arabic reason) on anything unsafe or damaged; files written before the error stay in destDir —
 * callers extract into a temporary directory and remove it on failure.
 */
export async function extractTarGz(archivePath: string, destDir: string, limits: TarExtractLimits): Promise<ExtractResult> {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(destDir);
  const ratioMin = limits.ratioMinBytes ?? 8 * 1024 * 1024;

  let compressed = 0;
  const src = createReadStream(archivePath);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      compressed += chunk.length;
      cb(null, chunk);
    },
  });
  const gunzip = createGunzip();
  src.on('error', (e) => gunzip.destroy(e));
  meter.on('error', (e) => gunzip.destroy(e));
  src.pipe(meter).pipe(gunzip);

  const entries: ExtractedEntry[] = [];
  const seen = new Set<string>();
  let inflated = 0;
  let declaredTotal = 0;
  let zeroBlocks = 0;
  let ended = false;
  let state = { kind: 'header' } as State;
  let buf: Buffer = Buffer.alloc(0);

  const closeData = (s: DataState) => {
    closeSync(s.fd);
    s.entry.sha256 = s.hash.digest('hex');
    entries.push(s.entry);
  };

  const handleHeader = (h: Buffer) => {
    if (h.every((b) => b === 0)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) ended = true;
      return;
    }
    if (zeroBlocks > 0) throw new ArchiveError('BAD_HEADER', 'بنية الأرشيف غير صالحة (بيانات بعد كتلة النهاية).');
    const stored = parseOctal(h.subarray(148, 156));
    if (stored !== checksum(h)) throw new ArchiveError('BAD_HEADER', 'المجموع الاختباري لترويسة عنصر في الأرشيف غير صحيح — الأرشيف تالف.');
    const type = String.fromCharCode(h[156]!);
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const magic = h.subarray(257, 263).toString('ascii');
    const prefix = magic.startsWith('ustar') ? h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readSizeField(h);
    if (type === '5') {
      if (size !== 0) throw new ArchiveError('BAD_HEADER', 'ترويسة مجلد غير صالحة في الأرشيف.');
      safeEntryName(fullName.replace(/\/+$/, ''));
      return;
    }
    if (type !== '0' && type !== '\0') {
      throw new ArchiveError('UNSUPPORTED_ENTRY', 'الأرشيف يحتوي عنصرًا غير مسموح (رابط رمزي أو صلب أو جهاز أو ترويسة امتداد) — رُفض كاملًا.');
    }
    const path = safeEntryName(fullName);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ArchiveError('DUPLICATE_NAME', 'الأرشيف يحتوي اسمًا مكررًا — رُفض كاملًا.');
    seen.add(key);
    if (entries.length + 1 > limits.maxEntries) throw new ArchiveError('TOO_MANY_ENTRIES', `عدد العناصر في الأرشيف يتجاوز الحد (${limits.maxEntries}).`);
    if (size > limits.maxEntryBytes) throw new ArchiveError('ENTRY_TOO_LARGE', 'حجم عنصر في الأرشيف يتجاوز الحد المسموح.');
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError('TOTAL_LIMIT', 'الحجم الكلي للأرشيف بعد فك الضغط يتجاوز الحد المسموح.');
    const target = writeTargetInside(root, path);
    const fd = openSync(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
    const s: DataState = { kind: 'data', remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, fd, hash: createHash('sha256'), entry: { path, size, sha256: '', absPath: target } };
    if (size === 0) {
      closeData(s);
      state = s.pad ? { kind: 'pad', remaining: s.pad } : { kind: 'header' };
    } else state = s;
  };

  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      inflated += chunk.length;
      if (inflated > limits.maxTotalBytes + 64 * 1024 * 1024) throw new ArchiveError('TOTAL_LIMIT', 'الحجم الكلي للأرشيف بعد فك الضغط يتجاوز الحد المسموح.');
      if (inflated > ratioMin && inflated / Math.max(1, compressed) > limits.maxRatio) {
        throw new ArchiveError('RATIO_EXCEEDED', 'نسبة الضغط مرتفعة بشكل غير طبيعي (احتمال قنبلة ضغط) — رُفض الأرشيف.');
      }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let off = 0;
      while (off < buf.length && !ended) {
        if (state.kind === 'header') {
          if (buf.length - off < BLOCK) break;
          handleHeader(buf.subarray(off, off + BLOCK));
          off += BLOCK;
        } else if (state.kind === 'data') {
          const n = Math.min(state.remaining, buf.length - off);
          const slice = buf.subarray(off, off + n);
          writeSync(state.fd, slice);
          state.hash.update(slice);
          state.remaining -= n;
          off += n;
          if (state.remaining === 0) {
            const pad = state.pad;
            closeData(state);
            state = pad ? { kind: 'pad', remaining: pad } : { kind: 'header' };
          }
        } else {
          const n = Math.min(state.remaining, buf.length - off);
          state.remaining -= n;
          off += n;
          if (state.remaining === 0) state = { kind: 'header' };
        }
      }
      buf = off >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(off));
      if (ended) break;
    }
  } catch (e) {
    if (state.kind === 'data') {
      try {
        closeSync(state.fd);
      } catch {
        /* ignore */
      }
    }
    src.destroy();
    gunzip.destroy();
    if (e instanceof ArchiveError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'Z_BUF_ERROR') throw new ArchiveError('TRUNCATED', 'الأرشيف مقطوع: انتهى الملف قبل نهاية البيانات المضغوطة.');
    if (code === 'Z_DATA_ERROR' || code === 'ERR_INVALID_ARG_TYPE') {
      throw new ArchiveError('NOT_GZIP', 'الملف ليس أرشيف نسخة احتياطية صالحًا (gzip تالف أو ليس gzip).');
    }
    throw e;
  }
  src.destroy();
  gunzip.destroy();
  if (!ended || state.kind !== 'header') throw new ArchiveError('TRUNCATED', 'الأرشيف مقطوع: لم تصل نهايته كاملة.');
  return { entries, compressedBytes: compressed, inflatedBytes: inflated };
}
