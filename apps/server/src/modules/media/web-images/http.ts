// The ONLY outbound layer of the web image search: a fixed allow-list of API hosts and image CDNs on top of the SSRF
// guard (lib/ssrf-guard.ts: server switch MEDLEVO_ALLOW_EXTERNAL_FETCH, https only, public addresses only, pinned DNS,
// every redirect hop re-validated — and here: re-checked against the allow-list too), with timeouts, size caps and
// content-type checks. Nothing else in the module opens a connection. Tests inject the transport / resolver.
import { AppError } from '../../../lib/errors';
import { safeFetch, type Resolver, type Transport } from '../../../lib/ssrf-guard';

/** search APIs the server may call */
export const API_HOSTS: readonly string[] = ['commons.wikimedia.org', 'openi.nlm.nih.gov', 'www.googleapis.com'];
/** image hosts the thumbnail proxy may fetch from (Wikimedia's CDN, Open-i itself, Google's thumbnail CDN) */
export const IMAGE_HOSTS: readonly string[] = ['upload.wikimedia.org', 'openi.nlm.nih.gov'];
/** Google's image thumbnails: encrypted-tbn0.gstatic.com … encrypted-tbn3.gstatic.com only */
const GSTATIC_THUMB = /^encrypted-tbn[0-3]\.gstatic\.com$/;

export function isAllowedApiHost(host: string): boolean {
  return API_HOSTS.includes(host.toLowerCase());
}
export function isAllowedImageHost(host: string): boolean {
  const h = host.toLowerCase();
  return IMAGE_HOSTS.includes(h) || GSTATIC_THUMB.test(h);
}
/** a URL the thumbnail proxy may fetch: https, default port, no credentials, allow-listed image host */
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && isAllowedImageHost(u.hostname);
  } catch {
    return false;
  }
}

export const JSON_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const API_TIMEOUT_MS = 8_000;
export const IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface WebHttpOptions {
  allowExternalFetch: boolean;
  transport?: Transport;
  resolver?: Resolver;
}

export interface WebHttp {
  /** GET a JSON document from an allow-listed API host */
  getJson(url: string, signal?: AbortSignal): Promise<unknown>;
  /** GET a raster image from an allow-listed image host (JPEG / PNG / GIF / WebP; never SVG); sniffed, size-capped */
  getImage(url: string, signal?: AbortSignal): Promise<{ body: Buffer; mime: string }>;
}

/** «JPEG / PNG / GIF / WebP» by the bytes themselves (the header alone is not trusted) */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const upstream = (status: number) => new AppError('BAD_REQUEST', `ردّ خدمة الصور بخطأ (${status}).`, 502);

export function createWebHttp(opts: WebHttpOptions): WebHttp {
  const base = { allowExternalFetch: opts.allowExternalFetch, transport: opts.transport, resolver: opts.resolver, allowedPorts: [443], maxRedirects: 2 };
  return {
    async getJson(url, signal) {
      const res = await safeFetch(url, { ...base, allowHost: isAllowedApiHost, timeoutMs: API_TIMEOUT_MS, maxBytes: JSON_MAX_BYTES, headers: { accept: 'application/json' }, signal });
      if (res.status !== 200) throw upstream(res.status);
      const ct = (res.headers['content-type'] ?? '').toLowerCase();
      if (!ct.includes('json') && !ct.startsWith('text/plain')) throw new AppError('BAD_REQUEST', 'ردّت خدمة الصور بمحتوى غير متوقع.', 502);
      try {
        return JSON.parse(res.body.toString('utf8')) as unknown;
      } catch {
        throw new AppError('BAD_REQUEST', 'ردّت خدمة الصور بمحتوى غير صالح.', 502);
      }
    },
    async getImage(url, signal) {
      const res = await safeFetch(url, { ...base, allowHost: isAllowedImageHost, timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES, headers: { accept: 'image/webp,image/png,image/jpeg,image/gif' }, signal });
      if (res.status !== 200) throw upstream(res.status);
      const declared = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const sniffed = sniffImage(res.body);
      if (!IMAGE_TYPES.has(declared) || !sniffed) throw new AppError('UNSUPPORTED_FORMAT', 'الملف المجلوب ليس صورة مدعومة (JPEG أو PNG أو GIF أو WebP).', 415);
      return { body: res.body, mime: sniffed };
    },
  };
}
