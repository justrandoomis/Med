// An in-process, S3-compatible fake for off-site backup tests (PL-0). It is NOT Cloudflare R2: it implements the
// subset the backup client uses (PUT/GET/HEAD/DELETE object, ListObjectsV2, multipart create/part/list/complete/
// abort) with R2's multipart rules (every part but the last the same size and ≥ the minimum part size), and it
// VERIFIES every request's SigV4 signature, payload hash and clock skew exactly as received on the wire — so a
// request the real service would refuse for a bad signature fails here too. Faults can be injected per operation.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseAuthorization, sha256Hex, signRequest } from '../../src/lib/objectstore/sigv4';

export type FakeOp =
  | 'PutObject'
  | 'GetObject'
  | 'HeadObject'
  | 'DeleteObject'
  | 'ListObjectsV2'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'ListParts'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload';

export interface FakeRequest {
  op: FakeOp;
  key: string | null;
  partNumber?: number;
  bytes: number;
}

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType: string;
  metadata: Record<string, string>;
  lastModified: number;
}

interface Upload {
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  parts: Map<number, { body: Buffer; etag: string }>;
}

export interface FakeS3Options {
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  /** R2: 5 MiB; tests use a smaller value with a matching client part size */
  minPartBytes?: number;
  /** cap on keys per ListObjectsV2 page (exercises pagination) */
  listPageSize?: number;
  now?: () => number;
}

interface Fault {
  op: FakeOp;
  remaining: number;
  kind: 'status' | 'drop' | 'lostAnswer';
  status?: number;
  code?: string;
  /** for 'drop' on GetObject: bytes sent before the connection is cut */
  afterBytes?: number;
  partNumber?: number;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeS3 {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, Upload>();
  readonly log: FakeRequest[] = [];
  readonly rejected: string[] = [];
  private faults: Fault[] = [];
  private server: http.Server | null = null;
  private readonly minPart: number;
  private readonly listPageSize: number;
  private readonly now: () => number;
  endpoint = '';

  constructor(o: FakeS3Options = {}) {
    this.bucket = o.bucket ?? 'medlevo-backups';
    this.accessKeyId = o.accessKeyId ?? 'AKIAFAKEFAKEFAKE0001';
    this.secretAccessKey = o.secretAccessKey ?? 'fake-secret/' + randomBytes(12).toString('hex');
    this.region = o.region ?? 'auto';
    this.minPart = o.minPartBytes ?? 5 * 1024 * 1024;
    this.listPageSize = o.listPageSize ?? 1000;
    this.now = o.now ?? Date.now;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.endpoint;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  /**
   * the next `times` requests of `op` fail with `status` (or have their connection cut). `lostAnswer`: the request IS
   * carried out, then the connection is cut before the answer (a response lost on the way back).
   */
  fail(op: FakeOp, times: number, f: { status?: number; code?: string; drop?: boolean; lostAnswer?: boolean; afterBytes?: number; partNumber?: number } = {}): void {
    this.faults.push({
      op,
      remaining: times,
      kind: f.lostAnswer ? 'lostAnswer' : f.drop ? 'drop' : 'status',
      status: f.status ?? 500,
      code: f.code ?? 'InternalError',
      afterBytes: f.afterBytes,
      partNumber: f.partNumber,
    });
  }

  /** forget every fault not used up yet (between tests) */
  clearFaults(): void {
    this.faults = [];
  }

  count(op: FakeOp): number {
    return this.log.filter((r) => r.op === op).length;
  }

  private takeFault(op: FakeOp, partNumber?: number): Fault | null {
    const f = this.faults.find((x) => x.op === op && x.remaining > 0 && (x.partNumber === undefined || x.partNumber === partNumber));
    if (!f) return null;
    f.remaining--;
    return f;
  }

  private error(res: http.ServerResponse, status: number, code: string, message = code): void {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`);
  }

  private verify(req: http.IncomingMessage, rawPath: string, query: Record<string, string>, body: Buffer): string | null {
    const auth = parseAuthorization(req.headers.authorization);
    if (!auth) return 'missing or malformed Authorization';
    if (auth.accessKeyId !== this.accessKeyId) return 'InvalidAccessKeyId';
    const datetime = String(req.headers['x-amz-date'] ?? '');
    if (!/^\d{8}T\d{6}Z$/.test(datetime)) return 'missing x-amz-date';
    const t = Date.UTC(+datetime.slice(0, 4), +datetime.slice(4, 6) - 1, +datetime.slice(6, 8), +datetime.slice(9, 11), +datetime.slice(11, 13), +datetime.slice(13, 15));
    if (Math.abs(t - this.now()) > 15 * 60_000) return 'RequestTimeTooSkewed';
    if (auth.scope !== `${datetime.slice(0, 8)}/${this.region}/s3/aws4_request`) return `bad scope ${auth.scope}`;
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256Hex(body)) return 'XAmzContentSHA256Mismatch';
    for (const must of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!auth.signedHeaders.includes(must)) return `${must} not signed`;
    const headers: Record<string, string> = {};
    for (const h of auth.signedHeaders) {
      const v = req.headers[h];
      if (v === undefined) return `signed header ${h} missing`;
      headers[h] = Array.isArray(v) ? v.join(',') : v;
    }
    const expected = signRequest(
      { method: req.method!, path: rawPath, query, headers, payloadHash, region: this.region, service: 's3', datetime },
      { accessKeyId: this.accessKeyId, secretAccessKey: () => this.secretAccessKey },
    );
    return expected.signature === auth.signature ? null : 'SignatureDoesNotMatch';
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url!, 'http://fake');
    const rawPath = req.url!.split('?')[0]!;
    const query: Record<string, string> = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    // the query on the wire must be the canonical one the client signed (we decode then re-encode like S3 does)
    const problem = this.verify(req, rawPath, query, body);
    if (problem) {
      this.rejected.push(problem);
      return this.error(res, 403, problem.startsWith('Request') ? problem : 'SignatureDoesNotMatch', problem);
    }
    const segs = rawPath.split('/').slice(1).map(decodeURIComponent);
    const bucket = segs[0];
    const key = segs.length > 1 ? segs.slice(1).join('/') : null;
    if (bucket !== this.bucket) return this.error(res, 404, 'NoSuchBucket');
    const m = req.method!;
    const op: FakeOp | null =
      m === 'GET' && key === null && query['list-type'] === '2'
        ? 'ListObjectsV2'
        : m === 'POST' && key && 'uploads' in query
          ? 'CreateMultipartUpload'
          : m === 'POST' && key && query.uploadId
            ? 'CompleteMultipartUpload'
            : m === 'PUT' && key && query.uploadId && query.partNumber
              ? 'UploadPart'
              : m === 'PUT' && key
                ? 'PutObject'
                : m === 'GET' && key && query.uploadId
                  ? 'ListParts'
                  : m === 'GET' && key
                    ? 'GetObject'
                    : m === 'HEAD' && key
                      ? 'HeadObject'
                      : m === 'DELETE' && key && query.uploadId
                        ? 'AbortMultipartUpload'
                        : m === 'DELETE' && key
                          ? 'DeleteObject'
                          : null;
    if (!op) return this.error(res, 400, 'NotImplemented');
    const partNumber = query.partNumber ? Number(query.partNumber) : undefined;
    this.log.push({ op, key, partNumber, bytes: body.length });
    const fault = this.takeFault(op, partNumber);
    if (fault?.kind === 'status') return this.error(res, fault.status!, fault.code!);
    if (fault?.kind === 'drop' && op !== 'GetObject') {
      req.socket.destroy();
      return;
    }
    if (fault?.kind === 'lostAnswer') {
      // do the work, but the answer never arrives
      res.writeHead = (() => res) as unknown as typeof res.writeHead;
      res.end = (() => {
        req.socket.destroy();
        return res;
      }) as unknown as typeof res.end;
    }

    switch (op) {
      case 'PutObject': {
        const etag = createHash('md5').update(body).digest('hex');
        this.objects.set(key!, { body, etag, contentType: String(req.headers['content-type'] ?? ''), metadata: meta(req), lastModified: this.now() });
        res.writeHead(200, { etag: `"${etag}"` });
        return void res.end();
      }
      case 'HeadObject': {
        const o = this.objects.get(key!);
        if (!o) {
          res.writeHead(404);
          return void res.end();
        }
        res.writeHead(200, { 'content-length': String(o.body.length), etag: `"${o.etag}"`, 'last-modified': new Date(o.lastModified).toUTCString(), ...Object.fromEntries(Object.entries(o.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v])) });
        return void res.end();
      }
      case 'GetObject': {
        const o = this.objects.get(key!);
        if (!o) return this.error(res, 404, 'NoSuchKey');
        let start = 0;
        const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
        if (range) start = Number(range[1]);
        const slice = o.body.subarray(start);
        res.writeHead(range ? 206 : 200, { 'content-length': String(slice.length), etag: `"${o.etag}"`, ...(range ? { 'content-range': `bytes ${start}-${o.body.length - 1}/${o.body.length}` } : {}) });
        if (fault?.kind === 'drop') {
          const n = Math.min(fault.afterBytes ?? Math.floor(slice.length / 2), slice.length - 1);
          res.write(slice.subarray(0, n), () => setTimeout(() => res.socket?.destroy(), 5));
          return;
        }
        return void res.end(slice);
      }
      case 'DeleteObject':
        this.objects.delete(key!);
        res.writeHead(204);
        return void res.end();
      case 'ListObjectsV2': {
        const prefix = query.prefix ?? '';
        const max = Math.min(Number(query['max-keys'] ?? '1000'), this.listPageSize);
        const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const startAfter = query['continuation-token'] ? Buffer.from(query['continuation-token'], 'base64url').toString() : null;
        const rest = startAfter ? all.filter((k) => k > startAfter) : all;
        const page = rest.slice(0, max);
        const truncated = rest.length > page.length;
        const items = page
          .map((k) => {
            const o = this.objects.get(k)!;
            return `<Contents><Key>${xml(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size></Contents>`;
          })
          .join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${
            truncated ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]!).toString('base64url')}</NextContinuationToken>` : ''
          }${items}</ListBucketResult>`,
        );
      }
      case 'CreateMultipartUpload': {
        const id = randomBytes(16).toString('base64url') + '+/=';
        this.uploads.set(id, { key: key!, contentType: String(req.headers['content-type'] ?? ''), metadata: meta(req), parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${xml(key!)}</Key><UploadId>${xml(id)}</UploadId></InitiateMultipartUploadResult>`);
      }
      case 'UploadPart': {
        const up = this.uploads.get(query.uploadId!);
        if (!up || up.key !== key) return this.error(res, 404, 'NoSuchUpload');
        const etag = createHash('md5').update(body).digest('hex');
        up.parts.set(partNumber!, { body, etag });
        res.writeHead(200, { etag: `"${etag}"` });
        return void res.end();
      }
      case 'ListParts': {
        const up = this.uploads.get(query.uploadId!);
        if (!up || up.key !== key) return this.error(res, 404, 'NoSuchUpload');
        const parts = [...up.parts.entries()].sort((a, b) => a[0] - b[0]);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><UploadId>${xml(query.uploadId!)}</UploadId><IsTruncated>false</IsTruncated>${parts
            .map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>"${p.etag}"</ETag><Size>${p.body.length}</Size></Part>`)
            .join('')}</ListPartsResult>`,
        );
      }
      case 'CompleteMultipartUpload': {
        const up = this.uploads.get(query.uploadId!);
        if (!up || up.key !== key) return this.error(res, 404, 'NoSuchUpload');
        const listed = [...body.toString('utf8').matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>"?([^<"]+)"?<\/ETag><\/Part>/g)].map((x) => ({ n: Number(x[1]), etag: x[2]! }));
        const bufs: Buffer[] = [];
        for (let i = 0; i < listed.length; i++) {
          const want = listed[i]!;
          const p = up.parts.get(want.n);
          if (!p || p.etag !== want.etag || want.n !== i + 1) return this.error(res, 400, 'InvalidPart');
          bufs.push(p.body);
        }
        const sizes = bufs.map((b) => b.length);
        for (let i = 0; i < sizes.length - 1; i++) {
          if (sizes[i]! < this.minPart) return this.error(res, 400, 'EntityTooSmall');
          if (sizes[i] !== sizes[0]) return this.error(res, 400, 'InvalidPart', 'All non-trailing parts must have the same length.');
        }
        const all = Buffer.concat(bufs);
        const md5s = Buffer.concat(listed.map((l) => Buffer.from(l.etag, 'hex')));
        const etag = `${createHash('md5').update(md5s).digest('hex')}-${listed.length}`;
        this.objects.set(key!, { body: all, etag, contentType: up.contentType, metadata: up.metadata, lastModified: this.now() });
        this.uploads.delete(query.uploadId!);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${xml(key!)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
      }
      case 'AbortMultipartUpload':
        this.uploads.delete(query.uploadId!);
        res.writeHead(204);
        return void res.end();
    }
  }
}

function meta(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-') && typeof v === 'string') out[k.slice('x-amz-meta-'.length)] = v;
  return out;
}
