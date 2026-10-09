import { describe, expect, it } from 'vitest';
import { blockedIpReason } from '../src/lib/ip';
import { type ResolvedAddress, safeFetch, type Transport, type TransportRequest } from '../src/lib/ssrf-guard';

const PUBLIC_V4 = '93.184.216.34';

function fakeDns(map: Record<string, string[]>) {
  return async (host: string): Promise<ResolvedAddress[]> => {
    const addrs = map[host];
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

function recordingTransport(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const r = responses.shift();
    if (!r) throw new Error('no response');
    return { status: r.status, headers: r.headers ?? {}, body: Buffer.from(r.body ?? '') };
  };
  return { calls, transport };
}

const base = { allowExternalFetch: true, resolver: fakeDns({ 'public.example': [PUBLIC_V4] }) };

describe('safeFetch (SSRF guard)', () => {
  it('is disabled unless external fetching is allowed by configuration', async () => {
    const { calls, transport } = recordingTransport([{ status: 200 }]);
    await expect(safeFetch('https://public.example/', { allowExternalFetch: false, transport })).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://172.16.5.4/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:a9fe:a9fe]/',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://[64:ff9b::a00:1]/',
    'https://2130706433/', // decimal form of 127.0.0.1 (normalized by the URL parser)
    'https://0x7f.0.0.1/',
    'https://localhost/',
    'https://foo.localhost/',
    'https://metadata.google.internal/',
    'https://intranet/',
  ])('blocks %s without connecting', async (url) => {
    const { calls, transport } = recordingTransport([{ status: 200 }]);
    await expect(safeFetch(url, { ...base, transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it('blocks hostnames that resolve to private addresses (any answer private → blocked)', async () => {
    const { calls, transport } = recordingTransport([{ status: 200 }]);
    const resolver = fakeDns({ 'rebind.example': [PUBLIC_V4, '10.0.0.7'], 'six.example': ['::1'] });
    await expect(safeFetch('https://rebind.example/', { allowExternalFetch: true, resolver, transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(safeFetch('https://six.example/', { allowExternalFetch: true, resolver, transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it('re-validates every redirect hop (redirect to metadata / private host is blocked)', async () => {
    const resolver = fakeDns({ 'public.example': [PUBLIC_V4], 'internal.example': ['10.0.0.5'] });
    const t1 = recordingTransport([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }]);
    await expect(safeFetch('https://public.example/a', { allowExternalFetch: true, allowHttp: true, resolver, transport: t1.transport })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(t1.calls).toHaveLength(1);

    const t2 = recordingTransport([{ status: 301, headers: { location: 'https://internal.example/admin' } }]);
    await expect(safeFetch('https://public.example/b', { allowExternalFetch: true, resolver, transport: t2.transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(t2.calls).toHaveLength(1);

    const t3 = recordingTransport([{ status: 302, headers: { location: 'http://public.example/' } }]);
    await expect(safeFetch('https://public.example/c', { allowExternalFetch: true, resolver, transport: t3.transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('caps redirects at 3', async () => {
    const hop = { status: 302, headers: { location: 'https://public.example/next' } };
    const { calls, transport } = recordingTransport([hop, hop, hop, hop, { status: 200 }]);
    await expect(safeFetch('https://public.example/', { ...base, transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(4);
  });

  it('rejects non-https schemes, credentials in URLs and unusual ports', async () => {
    const { calls, transport } = recordingTransport([{ status: 200 }]);
    for (const url of ['http://public.example/', 'ftp://public.example/', 'file:///etc/passwd', 'https://user:pass@public.example/', 'https://public.example:8080/']) {
      await expect(safeFetch(url, { ...base, transport })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(calls).toHaveLength(0);
  });

  it('fetches public URLs pinned to the validated address, without forwarding credentials', async () => {
    const { calls, transport } = recordingTransport([{ status: 302, headers: { location: '/final' } }, { status: 200, body: 'image-bytes' }]);
    const res = await safeFetch('https://public.example/start', {
      ...base,
      transport,
      headers: { cookie: 'medlevo_session=secret', authorization: 'Bearer x', accept: 'image/*' },
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('image-bytes');
    expect(res.finalUrl).toBe('https://public.example/final');
    expect(res.redirects).toEqual(['https://public.example/final']);
    expect(calls[0]!.address).toEqual({ address: PUBLIC_V4, family: 4 });
    for (const c of calls) {
      expect(c.headers['cookie']).toBeUndefined();
      expect(c.headers['authorization']).toBeUndefined();
      expect(c.headers['accept']).toBe('image/*');
    }
  });

  it('enforces the max response size', async () => {
    const { transport } = recordingTransport([{ status: 200, body: 'x'.repeat(2048) }]);
    await expect(safeFetch('https://public.example/', { ...base, transport, maxBytes: 1024 })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('IP classification', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local/metadata'],
    ['100.100.100.200', 'cgnat'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved/broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['fd00:ec2::254', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['2002:7f00:1::', 'loopback'],
    ['fe80::1%eth0', 'scoped-address'],
  ])('%s → %s', (ip, reason) => {
    expect(blockedIpReason(ip)).toBe(reason);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (ip) => {
    expect(blockedIpReason(ip)).toBeNull();
  });

  it('treats garbage as invalid', () => {
    expect(blockedIpReason('not-an-ip')).toBe('invalid');
    expect(blockedIpReason('1.2.3.256')).toBe('invalid');
  });
});
