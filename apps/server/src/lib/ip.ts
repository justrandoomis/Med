// IP address parsing and classification for the SSRF guard. Pure functions (no DNS).

export function parseIPv4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Parse an IPv6 literal (optionally bracketed, optional %zone) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.length === 0 || !s.includes(':')) return null;

  // embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1)
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = s.slice(0, lastColon + 1) + '0:0'; // placeholder groups, replaced below
  }

  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(dbl[0]!);
  const rest = dbl.length === 2 ? parseGroups(dbl[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function v4InCidr(ip: number, base: string, bits: number): boolean {
  const b = parseIPv4(base)!;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

const BLOCKED_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified/this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local/metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved/broadcast'],
];

export function classifyIPv4(ip: number): string | null {
  for (const [base, bits, label] of BLOCKED_V4) if (v4InCidr(ip, base, bits)) return label;
  return null;
}

function v6Prefix(groups: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i]! & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) >>> 0) + lo;
}

export function classifyIPv6(groups: number[]): string | null {
  const allZeroUntil = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (groups.every((g) => g === 0)) return 'unspecified';
  if (allZeroUntil(7) && groups[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d → classify the IPv4 address
  if (allZeroUntil(5) && groups[5] === 0xffff) {
    return classifyIPv4(embeddedV4(groups[6]!, groups[7]!)) ?? null;
  }
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765)
  if (allZeroUntil(4) && groups[4] === 0xffff && groups[5] === 0) {
    return classifyIPv4(embeddedV4(groups[6]!, groups[7]!)) ?? null;
  }
  // deprecated IPv4-compatible ::a.b.c.d
  if (allZeroUntil(6)) return 'ipv4-compatible';
  // NAT64 well-known prefix 64:ff9b::/96 → embedded IPv4
  if (v6Prefix(groups, [0x64, 0xff9b, 0, 0, 0, 0], 96)) {
    return classifyIPv4(embeddedV4(groups[6]!, groups[7]!)) ?? null;
  }
  if (v6Prefix(groups, [0x64, 0xff9b, 1], 48)) return 'nat64-local';
  if (v6Prefix(groups, [0x100, 0, 0, 0], 64)) return 'discard';
  if (v6Prefix(groups, [0x2001, 0xdb8], 32)) return 'documentation';
  if (v6Prefix(groups, [0x2001, 0], 23)) return 'ietf-protocol/teredo';
  // 6to4 2002::/16 → embedded IPv4 in groups 1-2
  if (v6Prefix(groups, [0x2002], 16)) {
    return classifyIPv4(embeddedV4(groups[1]!, groups[2]!)) ?? null;
  }
  if (v6Prefix(groups, [0xfc00], 7)) return 'unique-local';
  if (v6Prefix(groups, [0xfe80], 10)) return 'link-local';
  if (v6Prefix(groups, [0xfec0], 10)) return 'site-local';
  if (v6Prefix(groups, [0xff00], 8)) return 'multicast';
  return null;
}

/**
 * Returns a reason label when the address must not be contacted, null when it is a public unicast
 * address, or 'invalid' when it is not an IP literal.
 */
export function blockedIpReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) return classifyIPv4(v4);
  if (address.includes('%')) return 'scoped-address';
  const v6 = parseIPv6(address);
  if (v6 !== null) return classifyIPv6(v6);
  return 'invalid';
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}
