// Client-side encryption of backup archives before they leave the server (PL-0, docs/BACKUP_RESTORE.md §6).
//
// Format «MLVENC01» (authenticated, streaming, constant memory):
//   header (64 bytes) = magic "MLVENC01" | version u16 | chunk size u32 | key id (16 bytes) | salt (32 bytes) | 2 zero
//   then frames: AES-256-GCM(chunk_i) || tag (16 bytes); every frame but the last holds exactly `chunk size` bytes.
//   file key  = HKDF-SHA256(master key, salt, "medlevo-backup-v1 aes-256-gcm")   — a fresh random salt per archive
//   nonce_i   = u64be(i) | 0 0 0 | final flag (1 on the last frame only)          — the STREAM construction
//   AAD       = the 64-byte header (a changed header fails every frame)
// So reordered, dropped, duplicated, appended or truncated frames all fail authentication; a truncation exactly at a
// frame boundary fails because the new last frame was sealed without the final flag.
// The master key (MEDLEVO_BACKUP_ENCRYPTION_KEY, 32 bytes) never leaves the environment; only its key id (an HMAC of
// a constant) is stored next to each archive so a restore can say «this archive needs a different key».
// Losing the key makes every off-site archive unreadable — there is no recovery path by design.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const ENC_MAGIC = Buffer.from('MLVENC01', 'latin1');
export const ENC_VERSION = 1;
export const ENC_HEADER_BYTES = 64;
export const ENC_TAG_BYTES = 16;
export const ENC_DEFAULT_CHUNK = 1024 * 1024;
export const ENC_SUFFIX = '.mlenc';
const INFO = 'medlevo-backup-v1 aes-256-gcm';
const MAX_CHUNK = 64 * 1024 * 1024;

export class BackupKeyError extends Error {}

export type DecryptFailure = 'not_encrypted' | 'unsupported_version' | 'wrong_key' | 'tampered' | 'truncated';

const DECRYPT_AR: Record<DecryptFailure, string> = {
  not_encrypted: 'الملف ليس نسخة احتياطية مشفّرة من MedLevo.',
  unsupported_version: 'صيغة تشفير هذه النسخة أحدث من هذا الإصدار من الخادم. حدّث الخادم أولًا.',
  wrong_key: 'هذه النسخة مشفّرة بمفتاح غير المفتاح المضبوط الآن في MEDLEVO_BACKUP_ENCRYPTION_KEY. بدون المفتاح الأصلي لا يمكن فتحها.',
  tampered: 'فشل التحقق من سلامة النسخة المشفّرة: الملف تالف أو عُدِّل بعد تشفيره. لم يُستخدم منه شيء.',
  truncated: 'النسخة المشفّرة ناقصة أو آخرها تالف (انقطع تنزيلها أو رفعها، أو عُدِّلت). لم يُستخدم منها شيء.',
};

export class DecryptError extends Error {
  constructor(
    readonly reason: DecryptFailure,
    readonly details: { expectedKeyId?: string; foundKeyId?: string } = {},
  ) {
    super(`backup decryption failed: ${reason}`);
    this.name = 'DecryptError';
  }

  get reasonAr(): string {
    return DECRYPT_AR[this.reason];
  }
}

/** MEDLEVO_BACKUP_ENCRYPTION_KEY: 32 bytes as base64 / base64url (Render's generateValue) or 64 hex characters. */
export function parseBackupKey(raw: string): Buffer {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  throw new BackupKeyError('MEDLEVO_BACKUP_ENCRYPTION_KEY must be 32 random bytes as base64 (44 characters) or 64 hex characters');
}

/** A stable, non-secret fingerprint of a master key (hex, 32 characters). */
export function backupKeyId(master: Buffer): string {
  return createHmac('sha256', master).update('medlevo-backup-key-id-v1').digest('hex').slice(0, 32);
}

export function encryptedSize(plainSize: number, chunkSize = ENC_DEFAULT_CHUNK): number {
  return ENC_HEADER_BYTES + plainSize + ENC_TAG_BYTES * Math.max(1, Math.ceil(plainSize / chunkSize));
}

export interface EncHeader {
  version: number;
  chunkSize: number;
  keyId: string;
  salt: Buffer;
}

function buildHeader(chunkSize: number, keyId: string, salt: Buffer): Buffer {
  const h = Buffer.alloc(ENC_HEADER_BYTES);
  ENC_MAGIC.copy(h, 0);
  h.writeUInt16BE(ENC_VERSION, 8);
  h.writeUInt32BE(chunkSize, 10);
  Buffer.from(keyId, 'hex').copy(h, 14);
  salt.copy(h, 30);
  return h;
}

export function parseHeader(h: Buffer): EncHeader {
  if (h.length < ENC_HEADER_BYTES || !h.subarray(0, 8).equals(ENC_MAGIC)) throw new DecryptError('not_encrypted');
  const version = h.readUInt16BE(8);
  if (version !== ENC_VERSION) throw new DecryptError('unsupported_version');
  const chunkSize = h.readUInt32BE(10);
  if (chunkSize < 1 || chunkSize > MAX_CHUNK) throw new DecryptError('tampered');
  return { version, chunkSize, keyId: h.subarray(14, 30).toString('hex'), salt: Buffer.from(h.subarray(30, 62)) };
}

function fileKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, INFO, 32));
}

function nonce(index: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 0);
  n[11] = final ? 1 : 0;
  return n;
}

export interface EncryptOptions {
  /** 32 random bytes; pass the stored one to re-create byte-identical ciphertext (resuming an upload) */
  salt?: Buffer;
  chunkSize?: number;
}

/** plaintext in → «MLVENC01» out */
export class EncryptStream extends Transform {
  readonly salt: Buffer;
  readonly keyId: string;
  private readonly key: Buffer;
  private readonly header: Buffer;
  private readonly chunkSize: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0;
  private headerSent = false;

  constructor(master: Buffer, opts: EncryptOptions = {}) {
    super();
    if (master.length !== 32) throw new BackupKeyError('backup key must be 32 bytes');
    this.salt = opts.salt ?? randomBytes(32);
    if (this.salt.length !== 32) throw new BackupKeyError('salt must be 32 bytes');
    this.chunkSize = opts.chunkSize ?? ENC_DEFAULT_CHUNK;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 1 || this.chunkSize > MAX_CHUNK) throw new RangeError('chunk size');
    this.keyId = backupKeyId(master);
    this.key = fileKey(master, this.salt);
    this.header = buildHeader(this.chunkSize, this.keyId, this.salt);
  }

  private sendHeader(): void {
    if (!this.headerSent) {
      this.headerSent = true;
      this.push(this.header);
    }
  }

  private seal(plain: Buffer, final: boolean): void {
    const c = createCipheriv('aes-256-gcm', this.key, nonce(this.index++, final));
    c.setAAD(this.header);
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    this.push(body);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.sendHeader();
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    // a frame is sealed as non-final only when more bytes are known to follow it
    if (this.pendingBytes > this.chunkSize) {
      let all = Buffer.concat(this.pending, this.pendingBytes);
      while (all.length > this.chunkSize) {
        this.seal(all.subarray(0, this.chunkSize), false);
        all = all.subarray(this.chunkSize);
      }
      this.pending = [Buffer.from(all)];
      this.pendingBytes = all.length;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.sendHeader();
    this.seal(Buffer.concat(this.pending, this.pendingBytes), true);
    this.pending = [];
    this.pendingBytes = 0;
    cb();
  }
}

/** «MLVENC01» in → plaintext out; every frame is authenticated before its bytes are passed on. */
export class DecryptStream extends Transform {
  header: EncHeader | null = null;
  private key: Buffer | null = null;
  private headerBytes: Buffer | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private index = 0;

  constructor(
    private readonly master: Buffer,
    private readonly onHeader?: (h: EncHeader) => void,
  ) {
    super();
  }

  /** a failure on the LAST frame cannot tell truncation from damage: reported as «truncated» (ناقصة أو تالفة) */
  private open(frame: Buffer, final: boolean): Buffer {
    if (frame.length < ENC_TAG_BYTES) throw new DecryptError('truncated');
    const d = createDecipheriv('aes-256-gcm', this.key!, nonce(this.index++, final));
    d.setAAD(this.headerBytes!);
    d.setAuthTag(frame.subarray(frame.length - ENC_TAG_BYTES));
    try {
      return Buffer.concat([d.update(frame.subarray(0, frame.length - ENC_TAG_BYTES)), d.final()]);
    } catch {
      throw new DecryptError(final ? 'truncated' : 'tampered');
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      if (!this.header) {
        if (this.buf.length < ENC_HEADER_BYTES) return cb();
        this.headerBytes = Buffer.from(this.buf.subarray(0, ENC_HEADER_BYTES));
        const h = parseHeader(this.headerBytes);
        const mine = backupKeyId(this.master);
        if (h.keyId !== mine) throw new DecryptError('wrong_key', { expectedKeyId: h.keyId, foundKeyId: mine });
        this.header = h;
        this.key = fileKey(this.master, h.salt);
        this.onHeader?.(h);
        this.buf = this.buf.subarray(ENC_HEADER_BYTES);
      }
      const frame = this.header.chunkSize + ENC_TAG_BYTES;
      while (this.buf.length > frame) {
        this.push(this.open(this.buf.subarray(0, frame), false));
        this.buf = this.buf.subarray(frame);
      }
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.header) {
        // fewer than 64 bytes: a cut-off archive if what is there starts like ours, otherwise not ours at all
        const n = Math.min(ENC_MAGIC.length, this.buf.length);
        throw new DecryptError(this.buf.subarray(0, n).equals(ENC_MAGIC.subarray(0, n)) ? 'truncated' : 'not_encrypted');
      }
      if (this.buf.length === 0) throw new DecryptError('truncated');
      this.push(this.open(this.buf, true));
      this.buf = Buffer.alloc(0);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
}
