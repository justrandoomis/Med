// Proxy trust and the client address (PL-0, docs/DEPLOYMENT.md §3 and §8).
//
// The client address is what the login rate limiter and the session list record. Behind a proxy it comes from
// X-Forwarded-For, whose LEFT-most entries are written by the client and can be forged; only entries appended by
// proxies we trust are facts. MEDLEVO_TRUST_PROXY therefore says which proxies are trusted:
//   * `true`          — every peer (the documented nginx / Caddy setup that OVERWRITES X-Forwarded-For with exactly one
//                       address, so the left-most entry is the proxy's own observation). Unsafe for an appending chain.
//   * `<n>` (1–10)    — the n proxy hops closest to the app; the client is the entry n places from the right.
//   * `<list>`        — addresses / CIDR ranges / `loopback`, `linklocal`, `uniquelocal`: walk X-Forwarded-For from the
//                       right over trusted addresses; the first untrusted one is the client.
// MEDLEVO_CLIENT_IP_HEADER optionally names a header that the platform's edge sets to the client address and that a
// client cannot forge through that edge (Render routes every request through Cloudflare, which sets
// `CF-Connecting-IP`). It is honoured only when the TCP peer is a trusted proxy and the value is exactly one IP
// address; otherwise the trust setting above decides (for a hop count, an address written by the platform — never
// the forged head).
import { BlockList, isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';

export type ProxyTrust =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'hops'; hops: number }
  | { mode: 'list'; list: string[] };

export interface ProxyConfig {
  trust: ProxyTrust;
  /** lower-case header name, or null */
  clientIpHeader: string | null;
  /** the active setting in words (logs, Control Center); never contains a secret */
  description: string;
}

export const MAX_PROXY_HOPS = 10;
const KEYWORDS: Record<string, Array<[string, number, 'ipv4' | 'ipv6']>> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

/** headers that can never carry a single, platform-set client address */
const FORBIDDEN_CLIENT_IP_HEADERS = new Set(['x-forwarded-for', 'forwarded', 'host', 'cookie', 'authorization', 'x-forwarded-host', 'x-forwarded-proto', 'content-type', 'content-length']);

export class ProxyConfigError extends Error {}

/** `::ffff:10.0.0.1` → `10.0.0.1` (Node reports IPv4 peers of a dual-stack socket this way) */
export function normalizeIp(addr: string): string {
  const a = addr.trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  return m ? m[1]! : a;
}

function parseEntry(entry: string): Array<[string, number, 'ipv4' | 'ipv6']> | null {
  const e = entry.trim().toLowerCase();
  if (KEYWORDS[e]) return KEYWORDS[e]!;
  const [addr, prefix, ...rest] = e.split('/');
  if (rest.length || !addr) return null;
  const v = isIP(addr);
  if (v === 0) return null;
  const type = v === 4 ? 'ipv4' : 'ipv6';
  const max = v === 4 ? 32 : 128;
  if (prefix === undefined) return [[addr, max, type]];
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const p = Number(prefix);
  return p >= 0 && p <= max ? [[addr, p, type]] : null;
}

/** Parse MEDLEVO_TRUST_PROXY. Throws ProxyConfigError with a message naming the variable. */
export function parseTrustProxy(raw: string | undefined): ProxyTrust {
  const v = (raw ?? '').trim();
  const lower = v.toLowerCase();
  if (v === '' || ['false', 'no', 'off', '0'].includes(lower)) return { mode: 'none' };
  if (['true', 'yes', 'on'].includes(lower)) return { mode: 'all' };
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops < 1 || hops > MAX_PROXY_HOPS) throw new ProxyConfigError(`MEDLEVO_TRUST_PROXY: a hop count must be 1–${MAX_PROXY_HOPS} (got ${v})`);
    return { mode: 'hops', hops };
  }
  const list = v.split(',').map((s) => s.trim());
  for (const entry of list) {
    if (!entry || !parseEntry(entry)) {
      throw new ProxyConfigError(`MEDLEVO_TRUST_PROXY: "${entry}" is not an IP address, a CIDR range or one of loopback / linklocal / uniquelocal`);
    }
  }
  return { mode: 'list', list };
}

/** Parse MEDLEVO_CLIENT_IP_HEADER (requires a trusted proxy). */
export function parseClientIpHeader(raw: string | undefined, trust: ProxyTrust): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v) || FORBIDDEN_CLIENT_IP_HEADERS.has(v)) {
    throw new ProxyConfigError(`MEDLEVO_CLIENT_IP_HEADER: "${raw}" cannot carry a single client address set by the platform (e.g. cf-connecting-ip)`);
  }
  if (trust.mode === 'none') {
    throw new ProxyConfigError('MEDLEVO_CLIENT_IP_HEADER needs MEDLEVO_TRUST_PROXY: the header is honoured only when it comes from a trusted proxy');
  }
  return v;
}

export function describeProxy(trust: ProxyTrust, header: string | null): string {
  const t =
    trust.mode === 'none'
      ? 'no proxy trusted: the client address is the TCP peer'
      : trust.mode === 'all'
        ? 'every proxy trusted (X-Forwarded-For must be overwritten by the proxy)'
        : trust.mode === 'hops'
          ? `${trust.hops} proxy hop(s) trusted`
          : `proxies trusted by address: ${trust.list.join(', ')}`;
  return header ? `${t}; client address from the ${header} header of a trusted proxy` : t;
}

/** A matcher for an address list (IPv4-mapped IPv6 addresses are matched as IPv4). */
export function compileAddressList(list: string[]): (addr: string) => boolean {
  const bl = new BlockList();
  for (const entry of list) {
    for (const [addr, prefix, type] of parseEntry(entry) ?? []) bl.addSubnet(addr, prefix, type);
  }
  return (addr) => {
    const a = normalizeIp(addr);
    const v = isIP(a);
    if (v === 0) return false;
    try {
      return bl.check(a, v === 4 ? 'ipv4' : 'ipv6');
    } catch {
      return false;
    }
  };
}

/** trust(address, hopIndex): hopIndex 0 is the TCP peer, 1 the right-most X-Forwarded-For entry, … */
export type TrustFn = (address: string, hop: number) => boolean;

export function trustFunction(trust: ProxyTrust): TrustFn {
  switch (trust.mode) {
    case 'none':
      return () => false;
    case 'all':
      return () => true;
    case 'hops': {
      const n = trust.hops;
      return (_a, i) => i < n;
    }
    case 'list': {
      const match = compileAddressList(trust.list);
      return (a) => match(a);
    }
  }
}

/**
 * The value for Fastify's `trustProxy` option. A function for hop counts (Fastify 5.12 treats a bare number as
 * «trust nothing») and for address lists (one matcher implementation, tested here).
 */
export function fastifyTrustProxy(trust: ProxyTrust): boolean | TrustFn {
  if (trust.mode === 'none') return false;
  if (trust.mode === 'all') return true;
  return trustFunction(trust);
}

/**
 * When MEDLEVO_CLIENT_IP_HEADER is set: an onRequest hook (registered before every other hook) that, for a request
 * from a trusted peer carrying exactly one valid IP in that header, makes it the only X-Forwarded-For entry — so
 * `request.ip`, `request.ips` and every limiter keyed on them agree. Anything else is left to the trust setting.
 */
export function registerClientIpHeader(app: FastifyInstance, proxy: ProxyConfig): void {
  const header = proxy.clientIpHeader;
  if (!header) return;
  const trusted = trustFunction(proxy.trust);
  app.addHook('onRequest', (req, _reply, done) => {
    const raw = req.raw;
    const peer = raw.socket?.remoteAddress;
    const value = raw.headers[header];
    if (peer && typeof value === 'string' && trusted(peer, 0)) {
      const ip = normalizeIp(value);
      if (isIP(ip) !== 0) raw.headers['x-forwarded-for'] = ip;
    }
    done();
  });
}
