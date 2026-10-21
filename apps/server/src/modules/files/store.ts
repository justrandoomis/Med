// Content-addressed private file store: DATA_DIR/files/aa/bb/<sha256>.
// Writes go to DATA_DIR/tmp first (hash computed while streaming), are fsynced, then atomically
// renamed into place. Identical content is stored once (dedup by sha256). Files are never public:
// they are served only through authenticated routes or short-lived signed tokens.
// P1-T1 step 2 (hooks): a NEW row for a signed-in user's upload is checked against their storage quota first; every
// row is reported to the blob registry (system DB) as a reference of the bound database; a blob whose local copy is
// missing is fetched back from the object store (MEDLEVO_BLOB_STORE=r2) before it is read. Bytes are never deleted
// here (modules/files/blobs.ts).
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
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

/** What the tenancy layer plugs into the store (P1-T1 step 2; context.ts wires them). */
export interface FileStoreHooks {
  /** before a NEW stored_file row is written in the bound database: throws QUOTA_EXCEEDED for a user over quota */
  beforeNewFile?(size: number): void;
  /** a stored_file row for this content exists in the bound database (new, or found by content) */
  referenced?(meta: { sha256: string; size: number; mime: string; storageKey: string }): void;
  /** the local copy is missing: fetch it from the object store; false when it cannot be had */
  ensureLocal?(sha256: string, size: number): Promise<boolean>;
}

/** Which database a signed link resolves in, and for whom (ARCHITECTURE_DELTA §5.5 gate 5; P1-T1 step 1). */
export interface FileTokenScope {
  /** 'v:<vaultId>' (later 's:<spaceId>') */
  db: string;
  userId: string | null;
}

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
    /** the database (and user) of the current binding; tokens are only issued inside one */
    private readonly scope: () => FileTokenScope | null = () => null,
    private readonly hooks: FileStoreHooks = {},
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
      this.hooks.referenced?.({ sha256: existing.sha256, size: existing.size, mime: existing.mime, storageKey: existing.storage_key });
      return { ...toFile(existing), deduplicated: true };
    }
    try {
      this.hooks.beforeNewFile?.(size);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
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
      if (raced) {
        this.hooks.referenced?.({ sha256: raced.sha256, size: raced.size, mime: raced.mime, storageKey: raced.storage_key });
        return { ...toFile(raced), deduplicated: true };
      }
      throw e;
    }
    this.hooks.referenced?.({ sha256: row.sha256, size: row.size, mime: row.mime, storageKey: row.storage_key });
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

  /**
   * Absolute path of the blob. INTERNAL ONLY — never send to clients or logs shown to the owner. Synchronous: when the
   * local copy is missing and an object-store copy exists, the fetch starts in the background and the caller's read
   * fails this time (a retry finds it); async readers use `localPath`, `read` or `createReadStream`, which wait.
   */
  path(id: string): string {
    const f = this.stat(id);
    if (!f) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const p = this.absolute(f.storage_key);
    if (this.hooks.ensureLocal && !existsSync(p)) void this.hooks.ensureLocal(f.sha256, f.size);
    return p;
  }

  /** Absolute path of the blob once its bytes are on the local disk (fetched from the object store if needed). */
  async localPath(id: string): Promise<string> {
    const f = this.stat(id);
    if (!f) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const p = this.absolute(f.storage_key);
    if (!existsSync(p) && this.hooks.ensureLocal) await this.hooks.ensureLocal(f.sha256, f.size);
    return p;
  }

  async read(id: string): Promise<Buffer> {
    return readFile(await this.localPath(id));
  }

  createReadStream(id: string, range?: { start: number; end: number }): Readable {
    const f = this.stat(id);
    if (!f) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const p = this.absolute(f.storage_key);
    const opts = range ? { start: range.start, end: range.end } : undefined;
    if (existsSync(p) || !this.hooks.ensureLocal) return createReadStream(p, opts);
    // the local copy is missing: wait for the object store, then stream (errors reach the consumer)
    const out = new PassThrough();
    this.hooks
      .ensureLocal(f.sha256, f.size)
      .then((ok) => {
        if (!ok) throw new AppError('NOT_FOUND', 'الملف غير موجود أو لم يعد متاحًا.', 404);
        const src = createReadStream(p, opts);
        src.on('error', (e) => out.destroy(e));
        src.pipe(out);
      })
      .catch((e: unknown) => out.destroy(e as Error));
    return out;
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

  /**
   * Short-lived signed token for GET /api/files/t/:token (HMAC-SHA256). It carries {file, database, user, expiry}: the
   * public token route binds exactly that database, so a link never resolves a file id in anyone else's vault.
   */
  createToken(id: string, ttlMs: number): { token: string; expiresAt: number } {
    if (!this.stat(id)) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const scope = this.scope();
    if (!scope) throw new AppError('NOT_FOUND', 'الملف غير موجود.', 404);
    const ttl = Math.max(1000, Math.min(ttlMs, MAX_FILE_TOKEN_TTL_MS));
    const expiresAt = this.clock.now() + ttl;
    const payload = Buffer.from(JSON.stringify({ f: id, e: expiresAt, d: scope.db, u: scope.userId })).toString('base64url');
    const sig = hmacSha256(this.tokenKey, payload).toString('base64url');
    return { token: `${payload}.${sig}`, expiresAt };
  }

  /**
   * The file, database and user of a valid, unexpired token; null otherwise (never throws on bad input). Tokens
   * issued before P1-T1 (no database) are refused — they expired within the hour anyway.
   */
  verifyToken(token: string): { fileId: string; expiresAt: number; db: string; userId: string | null } | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = hmacSha256(this.tokenKey, payload).toString('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { f?: unknown; e?: unknown; d?: unknown; u?: unknown };
      if (typeof data.f !== 'string' || typeof data.e !== 'number' || typeof data.d !== 'string') return null;
      if (data.u !== null && typeof data.u !== 'string') return null;
      if (this.clock.now() >= data.e) return null;
      return { fileId: data.f, expiresAt: data.e, db: data.d, userId: (data.u as string | null) ?? null };
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
