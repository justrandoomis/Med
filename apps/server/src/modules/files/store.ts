// Content-addressed private file store: DATA_DIR/files/aa/bb/<sha256>.
// Writes go to DATA_DIR/tmp first (hash computed while streaming), are fsynced, then atomically
// renamed into place. Identical content is stored once (dedup by sha256). Files are never public:
// they are served only through authenticated routes or short-lived signed tokens.
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { StoredFileView } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { hmacSha256, safeEqual } from '../../lib/hash';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export interface StoredFile extends StoredFileView {
  /** relative path under DATA_DIR/files (internal only — never sent to clients) */
  storage_key: string;
}

export interface PutOptions {
  mime: string;
  originalName?: string | null;
  /** reject (PAYLOAD_TOO_LARGE) when the content exceeds this many bytes */
  maxBytes?: number;
}

export interface PutResult extends StoredFile {
  deduplicated: boolean;
}

export const MAX_FILE_TOKEN_TTL_MS = 60 * 60 * 1000;

interface StoredFileRow {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  storage_key: string;
  original_name: string | null;
  created_at: number;
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export function normalizeMime(mime: string | undefined | null): string {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return MIME_RE.test(base) ? base : 'application/octet-stream';
}

function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // directory fsync is not supported on every platform; data file fsync already happened
  }
}

export class FileStore {
  private readonly tokenKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly filesDir: string,
    private readonly tmpDir: string,
    tokenKey: Buffer,
    private readonly clock: Clock,
  ) {
    this.tokenKey = tokenKey;
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }

  static storageKeyFor(sha: string): string {
    return `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  /** Store content (buffer or stream). Same bytes → same stored_file row (deduplicated). */
  async put(input: Uint8Array | Readable, opts: PutOptions): Promise<PutResult> {
    const mime = normalizeMime(opts.mime);
    const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const tmp = join(this.tmpDir, `upload-${randomBytes(12).toString('hex')}`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new AppError('PAYLOAD_TOO_LARGE', 'حجم الملف أكبر من الحد المسموح للرفع.', 413));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const source = input instanceof Readable ? input : Readable.from([Buffer.from(input.buffer, input.byteOffset, input.byteLength)]);
    try {
      const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      await pipeline(source, meter, out);
      fsyncPath(tmp);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    const sha = hash.digest('hex');

    const existing = this.getBySha(sha);
    if (existing) {
      const existingPath = this.absolute(existing.storage_key);
      if (existsSync(existingPath)) rmSync(tmp, { force: true });
      else {
        // self-heal: the row exists but the blob went missing → we just received the same bytes
        mkdirSync(dirname(existingPath), { recursive: true, mode: 0o700 });
        renameSync(tmp, existingPath);
        fsyncPath(dirname(existingPath));
      }
      return { ...toFile(existing), deduplicated: true };
    }

    const storageKey = FileStore.storageKeyFor(sha);
    const finalPath = this.absolute(storageKey);
    mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
    if (existsSync(finalPath)) rmSync(tmp, { force: true });
    else {
      renameSync(tmp, finalPath);
      fsyncPath(dirname(finalPath));
    }

    const now = this.clock.now();
    const row: StoredFileRow = {
      id: newId(now),
      sha256: sha,
      size,
      mime,
      storage_key: storageKey,
      original_name: opts.originalName ? opts.originalName.slice(0, 512) : null,
      created_at: now,
    };
    try {
      this.db.run(
        'INSERT INTO stored_file (id, sha256, size, mime, storage_key, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.sha256, row.size, row.mime, row.storage_key, row.original_name, row.created_at],
      );
    } catch (e) {
      // concurrent put of identical content: the other insert won
      const raced = this.getBySha(sha);
      if (raced) return { ...toFile(raced), deduplicated: true };
      throw e;
    }
    return { ...toFile(row), deduplicated: false };
  }

  private getBySha(sha: string): StoredFileRow | undefined {
    return this.db.get<StoredFileRow>('SELECT * FROM stored_file WHERE sha256 = ?', [sha]);
  }

  private absolute(storageKey: string): string {
    return join(this.filesDir, ...storageKey.split('/'));
  }

  stat(id: string): StoredFile | null {
    const row = this.db.get<StoredFileRow>('SELECT * FROM stored_file WHERE id = ?', [id]);
    return row ? toFile(row) : null;
  }

  /** Absolute path of the blob. INTERNAL ONLY — never send to clients or logs shown to the owner. */
  path(id: string): string {
    const f = this.stat(id);
    if (!f) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    return this.absolute(f.storage_key);
  }

  async read(id: string): Promise<Buffer> {
    return readFile(this.path(id));
  }

  createReadStream(id: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(id), range ? { start: range.start, end: range.end } : undefined);
  }

  /** true when the blob exists on disk with the recorded size */
  verifyBlob(id: string): boolean {
    const f = this.stat(id);
    if (!f) return false;
    try {
      return statSync(this.absolute(f.storage_key)).size === f.size;
    } catch {
      return false;
    }
  }

  /** Short-lived signed token for GET /api/files/t/:token (HMAC-SHA256, bound to the file id). */
  createToken(id: string, ttlMs: number): { token: string; expiresAt: number } {
    if (!this.stat(id)) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const ttl = Math.max(1000, Math.min(ttlMs, MAX_FILE_TOKEN_TTL_MS));
    const expiresAt = this.clock.now() + ttl;
    const payload = Buffer.from(JSON.stringify({ f: id, e: expiresAt })).toString('base64url');
    const sig = hmacSha256(this.tokenKey, payload).toString('base64url');
    return { token: `${payload}.${sig}`, expiresAt };
  }

  /** Returns the file id for a valid, unexpired token; null otherwise (never throws on bad input). */
  verifyToken(token: string): { fileId: string; expiresAt: number } | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = hmacSha256(this.tokenKey, payload).toString('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { f?: unknown; e?: unknown };
      if (typeof data.f !== 'string' || typeof data.e !== 'number') return null;
      if (this.clock.now() >= data.e) return null;
      return { fileId: data.f, expiresAt: data.e };
    } catch {
      return null;
    }
  }
}

function toFile(r: StoredFileRow): StoredFile {
  return {
    id: r.id,
    sha256: r.sha256,
    size: r.size,
    mime: r.mime,
    storage_key: r.storage_key,
    original_name: r.original_name,
    created_at: r.created_at,
  };
}

export function toFileView(f: StoredFile): StoredFileView {
  return { id: f.id, sha256: f.sha256, size: f.size, mime: f.mime, original_name: f.original_name, created_at: f.created_at };
}
