// AWS Signature Version 4 for the S3 API (Cloudflare R2 speaks it), header-based authorization only.
// Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html and the S3
// «Signature Calculations for the Authorization Header» page. The published examples of both pages are unit tests
// (test/deploy/objectstore-sigv4.test.ts), so this file is checked against AWS's own numbers, not only against itself.
import { createHash, createHmac } from 'node:crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Credentials {
  accessKeyId: string;
  /** a function so the secret never sits in a serialisable object */
  secretAccessKey: () => string;
}

export interface SignRequest {
  method: string;
  /** the path exactly as sent, already percent-encoded with {@link awsUriEncode} per segment */
  path: string;
  /** decoded query parameters; '' for a flag such as `?uploads` */
  query?: Record<string, string>;
  /** header names in any case; `host` must be included */
  headers: Record<string, string>;
  /** hex sha256 of the body, or UNSIGNED-PAYLOAD */
  payloadHash: string;
  region: string;
  service: string;
  /** YYYYMMDDTHHMMSSZ */
  datetime: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as AWS requires: unreserved A–Z a–z 0–9 - _ . ~ stay; everything else is %XX (upper case). */
export function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `/bucket/a b/c` → `/bucket/a%20b/c` (S3 encodes each segment once; slashes between segments stay). */
export function encodePath(segments: string[]): string {
  return `/${segments.map((seg) => seg.split('/').map(awsUriEncode).join('/')).join('/')}`;
}

export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.entries(query)
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function canonicalRequest(r: SignRequest): { text: string; signedHeaders: string } {
  const headers = Object.entries(r.headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(';');
  const text = [r.method.toUpperCase(), r.path, canonicalQuery(r.query), headers.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, r.payloadHash].join('\n');
  return { text, signedHeaders };
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

export interface Signature {
  signature: string;
  signedHeaders: string;
  scope: string;
  authorization: string;
}

export function signRequest(r: SignRequest, creds: SigV4Credentials): Signature {
  const date = r.datetime.slice(0, 8);
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const { text, signedHeaders } = canonicalRequest(r);
  const stringToSign = [ALGORITHM, r.datetime, scope, sha256Hex(text)].join('\n');
  const signature = createHmac('sha256', signingKey(creds.secretAccessKey(), date, r.region, r.service)).update(stringToSign, 'utf8').digest('hex');
  return {
    signature,
    signedHeaders,
    scope,
    authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Parse an `Authorization: AWS4-HMAC-SHA256 …` header (used by the test fake to verify what was actually sent). */
export function parseAuthorization(h: string | undefined): { accessKeyId: string; scope: string; signedHeaders: string[]; signature: string } | null {
  if (!h) return null;
  const m = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/([^,\s]+), ?SignedHeaders=([^,\s]+), ?Signature=([0-9a-f]{64})$/.exec(h.trim());
  if (!m) return null;
  return { accessKeyId: m[1]!, scope: m[2]!, signedHeaders: m[3]!.split(';'), signature: m[4]! };
}
