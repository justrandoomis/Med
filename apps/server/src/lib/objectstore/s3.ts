// A small S3-API client for Cloudflare R2 (and any S3-compatible store): path-style URLs, SigV4 header signing with
// a hashed payload, retries with exponential backoff and jitter on network errors / 5xx / 429 / SlowDown, a
// per-request timeout, and resumable downloads (Range). Only what off-site backups need — no SDK dependency.
// Secrets: the secret access key is reached through a function and never logged; errors carry the store's error
// code and HTTP status, never a request signature or a key.
import { createWriteStream } from 'node:fs';
import { open, truncate } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { amzDate, canonicalQuery, EMPTY_SHA256, encodePath, sha256Hex, signRequest, type SigV4Credentials } from './sigv4';

export interface S3Target {
  /** e.g. https://<account id>.r2.cloudflarestorage.com (no bucket, no trailing slash) */
  endpoint: string;
  bucket: string;
  /** R2: 'auto' */
  region: string;
  credentials: SigV4Credentials;
}

export interface S3ClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** attempts per request, including the first (default 5) */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** per request (default 120 s) */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code} (HTTP ${status}): ${message}`);
    this.name = 'S3Error';
  }
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: number | null;
}

export interface HeadInfo {
  size: number;
  etag: string;
  lastModified: number | null;
  metadata: Record<string, string>;
}

export interface PartInfo {
  partNumber: number;
  etag: string;
  size: number;
}

const RETRY_CODES = new Set(['InternalError', 'SlowDown', 'RequestTimeout', 'ServiceUnavailable']);

export function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** inner XML of every `<name>…</name>` (no nesting of the same name in the S3 responses read here) */
function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]!);
}
function text(xml: string, name: string): string | null {
  const b = blocks(xml, name)[0];
  return b === undefined ? null : xmlDecode(b.trim());
}
const unquote = (etag: string) => etag.replace(/^"+|"+$/g, '').replace(/^W\//, '');

function parseError(status: number, body: string): S3Error {
  const code = (body && text(body, 'Code')) || (status === 404 ? 'NotFound' : status === 403 ? 'AccessDenied' : `HTTP${status}`);
  const message = (body && text(body, 'Message')) || '';
  const retryable = status >= 500 || status === 429 || RETRY_CODES.has(code);
  return new S3Error(status, code, message.slice(0, 300), retryable);
}

export class S3Client {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: URL;

  constructor(
    readonly target: S3Target,
    opts: S3ClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.retryMaxMs = opts.retryMaxMs ?? 20_000;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
    this.base = new URL(target.endpoint);
  }

  /** path-style: /<bucket>/<key> */
  private path(key: string | null): string {
    return encodePath(key === null ? [this.target.bucket] : [this.target.bucket, key]);
  }

  private async send(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    key: string | null,
    o: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer; signal?: AbortSignal; okStatus?: number[] } = {},
  ): Promise<Response> {
    const path = this.path(key);
    const payloadHash = o.body ? sha256Hex(o.body) : EMPTY_SHA256;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
      const url = new URL(path, this.base);
      // the query is sent exactly in its canonical (signed) form: RFC 3986, sorted
      url.search = canonicalQuery(o.query);
      const datetime = amzDate(this.now());
      const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': datetime, ...(o.headers ?? {}) };
      const sig = signRequest({ method, path, query: o.query, headers, payloadHash, region: this.target.region, service: 's3', datetime }, this.target.credentials);
      const sendHeaders = { ...headers, authorization: sig.authorization };
      delete (sendHeaders as Record<string, string | undefined>).host; // fetch sets Host from the URL (the same value)
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
      try {
        const res = await this.fetchFn(url, { method, headers: sendHeaders, body: o.body, signal, redirect: 'error' });
        if ((o.okStatus ?? [200]).includes(res.status)) return res;
        const body = method === 'HEAD' ? '' : await res.text().catch(() => '');
        const err = parseError(res.status, body);
        if (!err.retryable || attempt === this.maxAttempts) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof S3Error) {
          if (!e.retryable || attempt === this.maxAttempts) throw e;
          lastErr = e;
        } else {
          if (o.signal?.aborted) throw o.signal.reason ?? e;
          // network error or our own timeout: retry
          lastErr = new S3Error(0, (e as Error)?.name === 'TimeoutError' ? 'Timeout' : 'NetworkError', (e as Error)?.message ?? String(e), true);
          if (attempt === this.maxAttempts) throw lastErr;
        }
      }
      const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
      await this.sleep(Math.round(backoff / 2 + Math.random() * (backoff / 2)));
    }
    throw lastErr ?? new S3Error(0, 'Unknown', 'request failed', false);
  }

  async putObject(key: string, body: Buffer, o: RequestOptions & { contentType?: string; metadata?: Record<string, string> } = {}): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'content-type': o.contentType ?? 'application/octet-stream' };
    for (const [k, v] of Object.entries(o.metadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
    const res = await this.send('PUT', key, { headers, body, signal: o.signal });
    await res.arrayBuffer().catch(() => undefined);
    return { etag: unquote(res.headers.get('etag') ?? '') };
  }

  async headObject(key: string, o: RequestOptions = {}): Promise<HeadInfo | null> {
    try {
      const res = await this.send('HEAD', key, { signal: o.signal });
      const metadata: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.startsWith('x-amz-meta-')) metadata[k.slice('x-amz-meta-'.length)] = v;
      });
      const lm = res.headers.get('last-modified');
      return { size: Number(res.headers.get('content-length') ?? '0'), etag: unquote(res.headers.get('etag') ?? ''), lastModified: lm ? Date.parse(lm) : null, metadata };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  async deleteObject(key: string, o: RequestOptions = {}): Promise<void> {
    const res = await this.send('DELETE', key, { signal: o.signal, okStatus: [200, 204] });
    await res.arrayBuffer().catch(() => undefined);
  }

  /** every object under `prefix` (ListObjectsV2, all pages) */
  async listObjects(prefix: string, o: RequestOptions = {}): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | null = null;
    for (let page = 0; page < 10_000; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.send('GET', null, { query, signal: o.signal })).text();
      for (const c of blocks(xml, 'Contents')) {
        const key = text(c, 'Key');
        if (key === null) continue;
        const lm = text(c, 'LastModified');
        out.push({ key, size: Number(text(c, 'Size') ?? '0'), etag: unquote(text(c, 'ETag') ?? ''), lastModified: lm ? Date.parse(lm) : null });
      }
      if (text(xml, 'IsTruncated') !== 'true') return out;
      token = text(xml, 'NextContinuationToken');
      if (!token) return out;
    }
    return out;
  }

  async createMultipartUpload(key: string, o: RequestOptions & { contentType?: string; metadata?: Record<string, string> } = {}): Promise<string> {
    const headers: Record<string, string> = { 'content-type': o.contentType ?? 'application/octet-stream' };
    for (const [k, v] of Object.entries(o.metadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
    const xml = await (await this.send('POST', key, { query: { uploads: '' }, headers, signal: o.signal })).text();
    const id = text(xml, 'UploadId');
    if (!id) throw new S3Error(200, 'MalformedResponse', 'no UploadId in the answer', true);
    return id;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer, o: RequestOptions = {}): Promise<string> {
    const res = await this.send('PUT', key, { query: { partNumber: String(partNumber), uploadId }, body, signal: o.signal });
    await res.arrayBuffer().catch(() => undefined);
    return unquote(res.headers.get('etag') ?? '');
  }

  /** the parts already stored for an upload; null when the upload no longer exists (completed, aborted, expired) */
  async listParts(key: string, uploadId: string, o: RequestOptions = {}): Promise<PartInfo[] | null> {
    const out: PartInfo[] = [];
    let marker: string | null = null;
    try {
      for (let page = 0; page < 100; page++) {
        const query: Record<string, string> = { uploadId, 'max-parts': '1000' };
        if (marker) query['part-number-marker'] = marker;
        const xml = await (await this.send('GET', key, { query, signal: o.signal })).text();
        for (const p of blocks(xml, 'Part')) {
          out.push({ partNumber: Number(text(p, 'PartNumber')), etag: unquote(text(p, 'ETag') ?? ''), size: Number(text(p, 'Size') ?? '0') });
        }
        if (text(xml, 'IsTruncated') !== 'true') return out;
        marker = text(xml, 'NextPartNumberMarker');
        if (!marker) return out;
      }
      return out;
    } catch (e) {
      if (e instanceof S3Error && (e.code === 'NoSuchUpload' || e.status === 404)) return null;
      throw e;
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, o: RequestOptions = {}): Promise<{ etag: string }> {
    const body = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${xmlEscape(p.etag)}"</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`,
      'utf8',
    );
    const res = await this.send('POST', key, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body, signal: o.signal });
    const xml = await res.text();
    // S3 can answer 200 with an <Error> body for CompleteMultipartUpload
    if (/<Error>/.test(xml)) throw parseError(500, xml);
    return { etag: unquote(text(xml, 'ETag') ?? '') };
  }

  async abortMultipartUpload(key: string, uploadId: string, o: RequestOptions = {}): Promise<void> {
    try {
      const res = await this.send('DELETE', key, { query: { uploadId }, signal: o.signal, okStatus: [200, 204] });
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      if (e instanceof S3Error && (e.code === 'NoSuchUpload' || e.status === 404)) return;
      throw e;
    }
  }

  /**
   * Download an object into `destPath`, resuming with a Range request after a broken connection (the bytes already
   * written are kept). Returns the number of bytes written; throws when the size does not match `expectedSize`.
   */
  async getObjectToFile(key: string, destPath: string, o: RequestOptions & { expectedSize?: number; onProgress?: (bytes: number) => void } = {}): Promise<number> {
    await (await open(destPath, 'w', 0o600)).close();
    let written = 0;
    let lastErr: unknown = null;
    // (PL-0 review) the per-request timeout also ends a body that is still arriving: a round that brought bytes the
    // file never had is progress, not a failed attempt — only rounds without progress count towards maxAttempts, so a
    // large archive on a slow link is resumed (Range) until it is complete instead of failing after N timeouts.
    let best = 0;
    let failures = 0;
    for (;;) {
      try {
        const res = await this.send('GET', key, { headers: written > 0 ? { range: `bytes=${written}-` } : {}, signal: o.signal, okStatus: [200, 206] });
        if (res.status === 200 && written > 0) {
          // the store ignored the range: start again from the beginning
          await truncate(destPath, 0);
          written = 0;
        }
        if (!res.body) throw new S3Error(res.status, 'EmptyBody', 'no body', true);
        const out = createWriteStream(destPath, { flags: written > 0 ? 'r+' : 'w', start: written, mode: 0o600 });
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
            written += chunk.length;
            o.onProgress?.(written);
          }
        } finally {
          await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        }
        if (o.expectedSize !== undefined && written !== o.expectedSize) {
          throw new S3Error(200, 'SizeMismatch', `downloaded ${written} bytes, expected ${o.expectedSize}`, written < o.expectedSize);
        }
        return written;
      } catch (e) {
        if (o.signal?.aborted) throw o.signal.reason ?? e;
        if (e instanceof S3Error && !e.retryable) throw e;
        lastErr = e;
        if (written > best) {
          best = written;
          failures = 0;
        } else {
          failures++;
        }
        if (failures >= this.maxAttempts) break;
        await this.sleep(Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, failures - 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new S3Error(0, 'DownloadFailed', String(lastErr), false);
  }
}
