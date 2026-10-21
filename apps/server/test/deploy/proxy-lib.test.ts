// PL-0: the address-list matcher and trust functions behind MEDLEVO_TRUST_PROXY (lib/proxy.ts).
import { describe, expect, it } from 'vitest';
import { compileAddressList, fastifyTrustProxy, normalizeIp, parseTrustProxy, trustFunction } from '../../src/lib/proxy';

describe('address lists', () => {
  it('matches IPv4 and IPv6 CIDR ranges, single addresses and keywords; IPv4-mapped peers match as IPv4', () => {
    const m = compileAddressList(['10.0.0.0/8', '2001:db8::/32', '192.0.2.10', 'loopback']);
    expect(m('10.1.2.3')).toBe(true);
    expect(m('::ffff:10.1.2.3')).toBe(true);
    expect(m('11.0.0.1')).toBe(false);
    expect(m('2001:db8:1::5')).toBe(true);
    expect(m('2001:db9::1')).toBe(false);
    expect(m('192.0.2.10')).toBe(true);
    expect(m('192.0.2.11')).toBe(false);
    expect(m('127.0.0.1')).toBe(true);
    expect(m('::1')).toBe(true);
    expect(m('not-an-ip')).toBe(false);
    expect(m('')).toBe(false);
  });

  it('uniquelocal and linklocal cover the private and link-local ranges', () => {
    const m = compileAddressList(['uniquelocal', 'linklocal']);
    for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fd12::1', '169.254.1.1', 'fe80::1']) expect(m(a), a).toBe(true);
    for (const a of ['172.32.0.1', '8.8.8.8', '2001:4860::8888']) expect(m(a), a).toBe(false);
  });

  it('normalizeIp strips the IPv4-mapped prefix only', () => {
    expect(normalizeIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
  });
});

describe('trust functions', () => {
  it('hop counts trust exactly the n hops closest to the app (Fastify 5 treats a bare number as «trust nothing»)', () => {
    const t = trustFunction(parseTrustProxy('2'));
    expect([0, 1, 2, 3].map((i) => t('203.0.113.1', i))).toEqual([true, true, false, false]);
    expect(typeof fastifyTrustProxy(parseTrustProxy('2'))).toBe('function');
  });

  it('none / all map to Fastify false / true', () => {
    expect(fastifyTrustProxy(parseTrustProxy('false'))).toBe(false);
    expect(fastifyTrustProxy(parseTrustProxy('true'))).toBe(true);
  });
});
