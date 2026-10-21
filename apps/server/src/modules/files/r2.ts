// The R2 object-store adapter for blobs (P1-T1 step 2; ADR-0005 §B.5, PRD AOS-OC.7 / AOS-21.34). Off by default:
// MEDLEVO_BLOB_STORE=local keeps every blob on the server disk only, exactly as before. With MEDLEVO_BLOB_STORE=r2 every
// registered blob is ALSO copied to Cloudflare R2 (any S3-compatible store) through PL-0's SigV4 client, under a
// content-addressed key that mirrors the disk layout:
//
//     <MEDLEVO_R2_PREFIX>blobs/aa/bb/<sha256>.mlenc
//
// Each object is encrypted on this server first with PL-0's «MLVENC01» format (AES-256-GCM frames, a fresh salt per
// object, MEDLEVO_BACKUP_ENCRYPTION_KEY) — nothing leaves the host in clear (PRD NFR-S3). The disk stays a full cache in
// this step: a blob whose local copy is missing (a new disk, a lost file) is fetched back, decrypted, checked against
// its sha256 and size, and only then put in place. Deleting a remote copy is the GC's job alone (./gc.ts).
//
// Tested here against the in-process S3 fake that verifies every signature (apps/server/test/data/fake-s3.ts) — NOT
// against Cloudflare R2.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, ENC_DEFAULT_CHUNK, ENC_SUFFIX, EncryptStream, encryptedSize } from '../../lib/objectstore/encryption';
import { S3Client, type S3ClientOptions } from '../../lib/objectstore/s3';
import { uploadObject } from '../../lib/objectstore/upload';
import type { OffsiteConfig } from '../../lib/objectstore/offsite-config';

export interface ObjectBlobStore {
  readonly name: 'r2';
  /** the object key of a blob (content-addressed) */
  keyOf(sha256: string): string;
  /** upload the local file (encrypted) and confirm it with a HEAD of the expected size */
  put(sha256: string, localPath: string, size: number, signal?: AbortSignal): Promise<void>;
  /** the plain size recorded with the object, or null when absent */
  head(sha256: string, signal?: AbortSignal): Promise<{ size: number } | null>;
  /** download, decrypt and verify into `destPath` (written only when sha256 and size match) */
  get(sha256: string, size: number, destPath: string, signal?: AbortSignal): Promise<void>;
  delete(sha256: string, signal?: AbortSignal): Promise<void>;
}

export class BlobFetchError extends Error {
  constructor(
    readonly reason: 'missing' | 'mismatch' | 'decrypt' | 'transport',
    message: string,
  ) {
    super(message);
    this.name = 'BlobFetchError';
  }
}

export interface R2BlobStoreOptions {
  client?: S3ClientOptions;
  /** MLVENC01 frame size (tests use a small one) */
  encChunkSize?: number;
  /** multipart part size (R2 minimum 5 MiB; tests use the fake's smaller minimum) */
  partSizeBytes?: number;
}

export class R2BlobStore implements ObjectBlobStore {
  readonly name = 'r2' as const;
  private readonly client: S3Client;
  private readonly encChunk: number;
  private readonly partSize: number;

  constructor(
    private readonly cfg: Pick<OffsiteConfig, 'endpoint' | 'bucket' | 'region' | 'accessKeyId' | 'prefix' | 'partSizeBytes'>,
    secretAccessKey: () => string | null,
    private readonly masterKey: () => Buffer | null,
    private readonly tmpDir: string,
    opts: R2BlobStoreOptions = {},
  ) {
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId) throw new Error('R2 blob store: endpoint, bucket and access key are required');
    if (!secretAccessKey()) throw new Error('R2 blob store: MEDLEVO_R2_SECRET_ACCESS_KEY is required');
    this.client = new S3Client(
      { endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: () => secretAccessKey() ?? '' } },
      opts.client,
    );
    this.encChunk = opts.encChunkSize ?? ENC_DEFAULT_CHUNK;
    this.partSize = opts.partSizeBytes ?? cfg.partSizeBytes;
  }

  keyOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid blob address');
    return `${this.cfg.prefix}blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ENC_SUFFIX}`;
  }

  private master(): Buffer {
    const k = this.masterKey();
    if (!k) throw new Error('R2 blob store: MEDLEVO_BACKUP_ENCRYPTION_KEY is required');
    return k;
  }

  async put(sha256: string, localPath: string, size: number, signal?: AbortSignal): Promise<void> {
    const key = this.keyOf(sha256);
    const master = this.master();
    // P1-T1 step 2 review: only the bytes the key names ever leave — a damaged local copy (bit rot) uploaded here would
    // be recorded as the confirmed remote copy and could never be restored (get() verifies, so it would fail then)
    const local = await hashLocal(localPath);
    if (local.size !== size || local.sha256 !== sha256) throw new BlobFetchError('mismatch', `the local copy of ${sha256.slice(0, 12)} is damaged; it was not uploaded`);
    // one salt per upload attempt: a resumed multipart upload re-creates byte-identical ciphertext from it
    const salt = randomBytes(32);
    const total = encryptedSize(size, this.encChunk);
    await uploadObject(this.client, key, () => createReadStream(localPath).pipe(new EncryptStream(master, { salt, chunkSize: this.encChunk })), total, {
      partSize: this.partSize,
      contentType: 'application/octet-stream',
      metadata: { 'medlevo-sha256': sha256, 'medlevo-size': String(size) },
      signal,
    });
    const head = await this.client.headObject(key, { signal });
    if (!head || head.size !== total) throw new BlobFetchError('transport', `object ${key} has ${head?.size ?? 0} bytes after upload, expected ${total}`);
  }

  async head(sha256: string, signal?: AbortSignal): Promise<{ size: number } | null> {
    const h = await this.client.headObject(this.keyOf(sha256), { signal });
    if (!h) return null;
    const plain = Number(h.metadata['medlevo-size'] ?? NaN);
    return { size: Number.isFinite(plain) ? plain : -1 };
  }

  async get(sha256: string, size: number, destPath: string, signal?: AbortSignal): Promise<void> {
    const key = this.keyOf(sha256);
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    const enc = join(this.tmpDir, `blob-fetch-${randomBytes(8).toString('hex')}.mlenc`);
    try {
      const head = await this.client.headObject(key, { signal });
      if (!head) throw new BlobFetchError('missing', `object ${key} is not in the store`);
      await this.client.getObjectToFile(key, enc, { expectedSize: head.size, signal });
      const hash = createHash('sha256');
      let n = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          hash.update(chunk);
          n += chunk.length;
          cb(null, chunk);
        },
      });
      try {
        await pipeline(createReadStream(enc), new DecryptStream(this.master()), meter, createWriteStream(destPath, { flags: 'wx', mode: 0o600 }));
      } catch (e) {
        rmSync(destPath, { force: true });
        if (e instanceof BlobFetchError) throw e;
        throw new BlobFetchError('decrypt', `object ${key} could not be decrypted: ${(e as Error).message}`);
      }
      if (n !== size || hash.digest('hex') !== sha256) {
        rmSync(destPath, { force: true });
        throw new BlobFetchError('mismatch', `object ${key} does not hold the expected bytes`);
      }
    } finally {
      rmSync(enc, { force: true });
    }
  }

  async delete(sha256: string, signal?: AbortSignal): Promise<void> {
    await this.client.deleteObject(this.keyOf(sha256), { signal });
  }
}

/** sha256 and size of a local file (streamed). */
async function hashLocal(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const c of createReadStream(path)) {
    h.update(c as Buffer);
    size += (c as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

/** Size of a local file, or null. */
export function localSize(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}
