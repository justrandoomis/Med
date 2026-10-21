// Upload a (possibly large) object from a re-creatable byte stream: one PUT for small objects, a multipart upload
// with fixed-size parts otherwise (R2: every part but the last has the same size, ≥ 5 MiB, ≤ 10,000 parts).
// Resume: the caller stores the upload id (onUploadId) and passes it back after a crash or a failed attempt; the parts
// the store already holds are listed and skipped when their MD5 ETag matches the re-created bytes, so a resumed
// upload never mixes bytes of two different sources (the source must produce the same bytes again — off-site backups
// re-encrypt the same archive with the stored salt, which is deterministic).
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { S3Error, type S3Client } from './s3';

export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export interface UploadObjectOptions {
  partSize: number;
  contentType?: string;
  metadata?: Record<string, string>;
  /** a multipart upload started earlier for the SAME bytes */
  resumeUploadId?: string | null;
  onUploadId?: (uploadId: string) => void;
  onProgress?: (p: { bytes: number; totalBytes: number; partsDone: number; partsTotal: number; partsSkipped: number }) => void;
  signal?: AbortSignal;
}

export interface UploadObjectResult {
  etag: string;
  parts: number;
  partsSkipped: number;
  uploadId: string | null;
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

/** Part size for `total` bytes: at least `preferred`, large enough to stay within 10,000 parts, whole MiB. */
export function choosePartSize(total: number, preferred: number): number {
  const MiB = 1024 * 1024;
  const needed = Math.ceil(total / (MAX_PARTS - 1));
  return needed <= preferred ? preferred : Math.ceil(needed / MiB) * MiB;
}

async function* fixedChunks(source: Readable, size: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  let bytes = 0;
  for await (const c of source) {
    let chunk = c as Buffer;
    while (chunk.length > 0) {
      const take = Math.min(size - bytes, chunk.length);
      parts.push(chunk.subarray(0, take));
      bytes += take;
      chunk = chunk.subarray(take);
      if (bytes === size) {
        yield Buffer.concat(parts, bytes);
        parts = [];
        bytes = 0;
      }
    }
  }
  if (bytes > 0) yield Buffer.concat(parts, bytes);
}

export async function uploadObject(client: S3Client, key: string, openSource: () => Readable, totalBytes: number, o: UploadObjectOptions): Promise<UploadObjectResult> {
  const partSize = choosePartSize(totalBytes, o.partSize);
  if (totalBytes <= partSize) {
    const chunks: Buffer[] = [];
    for await (const c of openSource()) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (body.length !== totalBytes) throw new S3Error(0, 'SourceChanged', `source produced ${body.length} bytes, expected ${totalBytes}`, false);
    const r = await client.putObject(key, body, { contentType: o.contentType, metadata: o.metadata, signal: o.signal });
    o.onProgress?.({ bytes: totalBytes, totalBytes, partsDone: 1, partsTotal: 1, partsSkipped: 0 });
    return { etag: r.etag, parts: 1, partsSkipped: 0, uploadId: null };
  }

  const partsTotal = Math.ceil(totalBytes / partSize);
  let uploadId: string | null = null;
  let existing = new Map<number, { etag: string; size: number }>();
  if (o.resumeUploadId) {
    const listed = await client.listParts(key, o.resumeUploadId, { signal: o.signal });
    if (listed) {
      uploadId = o.resumeUploadId;
      existing = new Map(listed.map((p) => [p.partNumber, { etag: p.etag, size: p.size }]));
    }
  }
  if (!uploadId) {
    uploadId = await client.createMultipartUpload(key, { contentType: o.contentType, metadata: o.metadata, signal: o.signal });
    o.onUploadId?.(uploadId);
  }

  const done: Array<{ partNumber: number; etag: string }> = [];
  let partNumber = 0;
  let bytes = 0;
  let skipped = 0;
  for await (const part of fixedChunks(openSource(), partSize)) {
    partNumber++;
    if (partNumber > partsTotal) throw new S3Error(0, 'SourceChanged', 'source produced more bytes than announced', false);
    if (partNumber < partsTotal && part.length !== partSize) throw new S3Error(0, 'SourceChanged', 'source ended early', false);
    const sum = md5(part);
    const have = existing.get(partNumber);
    let etag: string;
    if (have && have.etag.toLowerCase() === sum && have.size === part.length) {
      etag = have.etag;
      skipped++;
    } else {
      etag = await client.uploadPart(key, uploadId, partNumber, part, { signal: o.signal });
      // a part's ETag is the MD5 of what the store received: a mismatch means bytes changed on the way
      if (/^[0-9a-f]{32}$/i.test(etag) && etag.toLowerCase() !== sum) throw new S3Error(0, 'PartCorrupted', `part ${partNumber} arrived damaged`, true);
    }
    done.push({ partNumber, etag });
    bytes += part.length;
    o.onProgress?.({ bytes, totalBytes, partsDone: partNumber, partsTotal, partsSkipped: skipped });
  }
  if (bytes !== totalBytes || partNumber !== partsTotal) throw new S3Error(0, 'SourceChanged', `source produced ${bytes} bytes, expected ${totalBytes}`, false);
  try {
    const r = await client.completeMultipartUpload(key, uploadId, done, { signal: o.signal });
    return { etag: r.etag, parts: partsTotal, partsSkipped: skipped, uploadId };
  } catch (e) {
    // (PL-0 review) the store completed the upload but its answer was lost: the retry then finds no such upload. The
    // object is ours (the key is unique to this archive and the bytes are re-created identically) — accept it when
    // it is there with exactly the announced size; the caller confirms the size again with its own HEAD.
    if (e instanceof S3Error && (e.code === 'NoSuchUpload' || e.status === 404)) {
      const head = await client.headObject(key, { signal: o.signal });
      if (head && head.size === totalBytes) return { etag: head.etag, parts: partsTotal, partsSkipped: skipped, uploadId };
    }
    throw e;
  }
}
