// Guarded outbound fetch (§49). The server is never an open proxy for links found inside files.
//  * disabled entirely unless the configuration allows external fetching
//  * https only (http only when explicitly allowed), default ports only unless allowed
//  * no URL credentials; caller-supplied cookie/authorization headers are dropped
//  * DNS is resolved by us and EVERY resolved address must be public unicast; the connection is pinned
//    to the validated address (no DNS-rebinding TOCTOU); IP literals are validated directly
//  * every redirect hop is re-validated (max 3), with timeout and a hard response size cap
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { AppError } from './errors';
import { blockedIpReason, parseIPv4, parseIPv6 } from './ip';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** validated address the connection must use */
  address: ResolvedAddress;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  /** must be true (from config.allowExternalFetch) or the call is refused */
  allowExternalFetch: boolean;
  allowHttp?: boolean;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  signal?: AbortSignal;
  /** injectable for tests; default: node:dns lookup (all addresses) */
  resolver?: Resolver;
  /** injectable for tests; default: node:http(s) pinned to the validated address */
  transport?: Transport;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
  redirects: string[];
}

export class SsrfBlockedError extends AppError {
  readonly reason: string;
  constructor(reason: string, messageAr: string) {
    super('FORBIDDEN', messageAr, 403, { reason });
    this.reason = reason;
  }
}

const MAX_REDIRECTS_CAP = 3;
const FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'x-medlevo-csrf']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata', 'metadata.google.internal', 'instance-data']);

const defaultResolver: Resolver = async (hostname) => {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

function hostOf(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Validates scheme/credentials/port/host name. Returns the bare host. */
export function validateUrlShape(url: URL, opts: Pick<SafeFetchOptions, 'allowHttp' | 'allowedPorts'>): string {
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SsrfBlockedError('scheme', 'الرابط غير مسموح: يُقبل بروتوكول HTTPS فقط.');
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('credentials', 'الرابط غير مسموح: يحتوي على بيانات دخول.');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const allowedPorts = opts.allowedPorts ?? [443, 80];
  if (!allowedPorts.includes(port)) {
    throw new SsrfBlockedError('port', 'الرابط غير مسموح: المنفذ غير مسموح.');
  }
  const host = hostOf(url).toLowerCase().replace(/\.$/, '');
  if (!host) throw new SsrfBlockedError('host', 'الرابط غير صالح.');
  const singleLabel = !host.includes('.') && !host.includes(':');
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || singleLabel) {
    throw new SsrfBlockedError('internal-host', 'الرابط غير مسموح: يشير إلى عنوان داخلي.');
  }
  return host;
}

function assertPublic(address: string): void {
  const reason = blockedIpReason(address);
  if (reason !== null) {
    throw new SsrfBlockedError(`ip:${reason}`, 'الرابط غير مسموح: يشير إلى عنوان شبكة داخلي أو محجوز.');
  }
}

async function resolveAndValidate(host: string, resolver: Resolver): Promise<ResolvedAddress> {
  if (parseIPv4(host) !== null) {
    assertPublic(host);
    return { address: host, family: 4 };
  }
  if (parseIPv6(host) !== null) {
    assertPublic(host);
    return { address: host, family: 6 };
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new AppError('BAD_REQUEST', 'تعذر الوصول إلى الرابط: لم يُعثر على العنوان.', 502);
  }
  if (addrs.length === 0) throw new AppError('BAD_REQUEST', 'تعذر الوصول إلى الرابط: لم يُعثر على العنوان.', 502);
  // Every address must be public — an attacker controlling DNS could mix public and private answers.
  for (const a of addrs) assertPublic(a.address);
  return addrs[0]!;
}

const defaultTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, options, cb) => {
      if ((options as { all?: boolean }).all) {
        (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address: req.address.address, family: req.address.family },
        ]);
      } else {
        cb(null, req.address.address, req.address.family);
      }
    };
    const mod = req.url.protocol === 'https:' ? https : http;
    const r = mod.request(
      req.url,
      { method: req.method, headers: req.headers, lookup: pinned, signal: req.signal, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > req.maxBytes) {
            res.destroy();
            reject(new AppError('PAYLOAD_TOO_LARGE', 'المحتوى الخارجي أكبر من الحد المسموح.', 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    r.on('error', reject);
    r.end();
  });

/**
 * Fetch an external URL under SSRF restrictions. Throws AppError (FEATURE_DISABLED, FORBIDDEN,
 * PAYLOAD_TOO_LARGE, BAD_REQUEST) with an Arabic message; never returns internal network content.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  if (!opts.allowExternalFetch) {
    throw new AppError('FEATURE_DISABLED', 'جلب الروابط الخارجية معطّل في إعدادات الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH).', 409);
  }
  const maxRedirects = Math.min(opts.maxRedirects ?? MAX_REDIRECTS_CAP, MAX_REDIRECTS_CAP);
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const resolver = opts.resolver ?? defaultResolver;
  const transport = opts.transport ?? defaultTransport;
  const method = opts.method ?? 'GET';

  const headers: Record<string, string> = { 'user-agent': 'MedLevo/1 (+personal study app)', accept: '*/*' };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 'الرابط غير صالح.', 400);
  }
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    const host = validateUrlShape(url, opts);
    const address = await resolveAndValidate(host, resolver);
    let res: TransportResponse;
    try {
      res = await transport({ url, address, method, headers, signal, maxBytes });
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (signal.aborted) throw new AppError('BAD_REQUEST', 'انتهت مهلة الاتصال بالرابط الخارجي.', 504);
      throw new AppError('BAD_REQUEST', 'تعذر الاتصال بالرابط الخارجي.', 502);
    }
    if (res.body.length > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'المحتوى الخارجي أكبر من الحد المسموح.', 413);
    if (res.status >= 300 && res.status < 400 && res.headers['location']) {
      if (hop >= maxRedirects) throw new SsrfBlockedError('too-many-redirects', 'الرابط يعيد التوجيه أكثر من الحد المسموح.');
      let next: URL;
      try {
        next = new URL(res.headers['location'], url);
      } catch {
        throw new AppError('BAD_REQUEST', 'إعادة توجيه إلى رابط غير صالح.', 502);
      }
      redirects.push(next.toString());
      url = next; // validated at the top of the next iteration (scheme, host, DNS, IP)
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, finalUrl: url.toString(), redirects };
  }
}
