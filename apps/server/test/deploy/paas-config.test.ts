// PL-0 (phone-only operation): configuration a PaaS host needs — the web origin falls back to the address the
// platform gives the service (Render: RENDER_EXTERNAL_URL), and proxy trust is a hop count, an address list or
// `true` (the documented nginx / Caddy setup), optionally with a named client-address header set by the platform.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, REPO_ROOT } from '../../src/config';

const base = { NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/medlevo-paas-config' };

describe('web origin on a PaaS host', () => {
  it('MEDLEVO_ORIGIN unset → RENDER_EXTERNAL_URL is the origin (https → Secure cookies)', () => {
    const c = loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com' });
    expect(c.origin).toBe('https://medlevo-abc1.onrender.com');
    expect(c.allowedOrigins).toEqual(['https://medlevo-abc1.onrender.com']);
    expect(c.originSource).toBe('RENDER_EXTERNAL_URL');
    expect(c.cookieSecure).toBe(true);
  });

  it('an explicit MEDLEVO_ORIGIN always wins over RENDER_EXTERNAL_URL (a custom domain)', () => {
    const c = loadConfig({ ...base, MEDLEVO_ORIGIN: 'https://study.example.org', RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com' });
    expect(c.origin).toBe('https://study.example.org');
    expect(c.allowedOrigins).toEqual(['https://study.example.org']);
    expect(c.originSource).toBe('MEDLEVO_ORIGIN');
  });

  it('MEDLEVO_ORIGIN=auto (the blueprint value) means RENDER_EXTERNAL_URL, and is refused where Render did not set it', () => {
    const c = loadConfig({ ...base, MEDLEVO_ORIGIN: 'auto', RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com' });
    expect(c.origin).toBe('https://medlevo-abc1.onrender.com');
    expect(c.originSource).toBe('RENDER_EXTERNAL_URL');
    expect(() => loadConfig({ ...base, MEDLEVO_ORIGIN: 'auto' })).toThrow(/RENDER_EXTERNAL_URL/);
  });

  it('an empty MEDLEVO_ORIGIN (a blank dashboard field) is treated as unset', () => {
    const c = loadConfig({ ...base, MEDLEVO_ORIGIN: '  ', RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com/' });
    expect(c.origin).toBe('https://medlevo-abc1.onrender.com');
  });

  it('neither set → the local development default, as before', () => {
    const c = loadConfig({ ...base });
    expect(c.origin).toBe('http://localhost:5173');
    expect(c.originSource).toBe('default');
    expect(c.cookieSecure).toBe(false);
  });

  it('a malformed RENDER_EXTERNAL_URL is refused with a precise message (never a silent wrong origin)', () => {
    expect(() => loadConfig({ ...base, RENDER_EXTERNAL_URL: 'not a url' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RENDER_EXTERNAL_URL: 'ftp://x.onrender.com' })).toThrow(/RENDER_EXTERNAL_URL/);
  });
});

describe('MEDLEVO_TRUST_PROXY', () => {
  it('unset / false / 0 / off → no proxy is trusted', () => {
    for (const v of [undefined, '', 'false', '0', 'off', 'no']) {
      const c = loadConfig({ ...base, ...(v === undefined ? {} : { MEDLEVO_TRUST_PROXY: v }) });
      expect(c.proxy.trust).toEqual({ mode: 'none' });
      expect(c.trustProxy).toBe(false);
    }
  });

  it('true / yes / on → trust every proxy (documented nginx / Caddy setup that OVERWRITES X-Forwarded-For)', () => {
    for (const v of ['true', 'TRUE', 'yes', 'on']) {
      const c = loadConfig({ ...base, MEDLEVO_TRUST_PROXY: v });
      expect(c.proxy.trust).toEqual({ mode: 'all' });
      expect(c.trustProxy).toBe(true);
    }
  });

  it('a positive integer → that many proxy hops (the client is the entry that many places from the right)', () => {
    expect(loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '1' }).proxy.trust).toEqual({ mode: 'hops', hops: 1 });
    expect(loadConfig({ ...base, MEDLEVO_TRUST_PROXY: ' 3 ' }).proxy.trust).toEqual({ mode: 'hops', hops: 3 });
    expect(loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '3' }).trustProxy).toBe(true);
    expect(() => loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '99' })).toThrow(/MEDLEVO_TRUST_PROXY/);
  });

  it('a comma-separated list of addresses, CIDR ranges or the keywords loopback / linklocal / uniquelocal', () => {
    const c = loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12,uniquelocal, 192.0.2.10, fd00::/8, loopback' });
    expect(c.proxy.trust).toEqual({ mode: 'list', list: ['10.0.0.0/8', '172.16.0.0/12', 'uniquelocal', '192.0.2.10', 'fd00::/8', 'loopback'] });
    expect(c.trustProxy).toBe(true);
    for (const bad of ['10.0.0.0/33', 'example.com', '10.0.0.0/8,', '300.1.1.1', 'fd00::/129', 'true,10.0.0.0/8']) {
      expect(() => loadConfig({ ...base, MEDLEVO_TRUST_PROXY: bad }), bad).toThrow(/MEDLEVO_TRUST_PROXY/);
    }
  });

  it('MEDLEVO_CLIENT_IP_HEADER is honoured only together with a trusted proxy, and only a sane header name', () => {
    const c = loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '1', MEDLEVO_CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    expect(c.proxy.clientIpHeader).toBe('cf-connecting-ip');
    expect(() => loadConfig({ ...base, MEDLEVO_CLIENT_IP_HEADER: 'cf-connecting-ip' })).toThrow(/MEDLEVO_TRUST_PROXY/);
    for (const bad of ['x-forwarded-for', 'X-Forwarded-For', 'forwarded', 'cookie', 'host', 'bad header', 'a:b']) {
      expect(() => loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '1', MEDLEVO_CLIENT_IP_HEADER: bad }), bad).toThrow(/MEDLEVO_CLIENT_IP_HEADER/);
    }
  });

  it('describes the active setting in words for the logs (no secrets)', () => {
    expect(loadConfig({ ...base, MEDLEVO_TRUST_PROXY: '1', MEDLEVO_CLIENT_IP_HEADER: 'cf-connecting-ip' }).proxy.description).toMatch(/cf-connecting-ip/);
    expect(loadConfig({ ...base }).proxy.description).toMatch(/none|no proxy/i);
  });
});

describe('.env.example (PL-0 settings)', () => {
  it('documents the proxy and off-site settings and commits no secret value', () => {
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    for (const k of ['MEDLEVO_CLIENT_IP_HEADER', 'MEDLEVO_R2_ACCOUNT_ID', 'MEDLEVO_R2_BUCKET', 'MEDLEVO_R2_ACCESS_KEY_ID', 'MEDLEVO_R2_SECRET_ACCESS_KEY', 'MEDLEVO_BACKUP_ENCRYPTION_KEY', 'MEDLEVO_BACKUP_SCHEDULE']) {
      expect(example).toMatch(new RegExp(`^${k}=`, 'm'));
    }
    for (const line of example.split('\n')) {
      if (/^(MEDLEVO_R2_ACCESS_KEY_ID|MEDLEVO_R2_SECRET_ACCESS_KEY|MEDLEVO_BACKUP_ENCRYPTION_KEY|MEDLEVO_R2_ACCOUNT_ID)=/.test(line)) expect(line.split('=')[1]).toBe('');
    }
  });
});

describe('off-site endpoint (the only host the backup client ever calls)', () => {
  const r2 = { MEDLEVO_R2_BUCKET: 'medlevo-backups', MEDLEVO_R2_ACCESS_KEY_ID: 'AK', MEDLEVO_R2_SECRET_ACCESS_KEY: 'SK', MEDLEVO_BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  it('comes from the account id or an https endpoint; plain http only on loopback; never with a path', () => {
    expect(loadConfig({ ...base, ...r2, MEDLEVO_R2_ACCOUNT_ID: 'a'.repeat(32) }).offsite).toMatchObject({ configured: true, endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com` });
    expect(loadConfig({ ...base, ...r2, MEDLEVO_R2_ENDPOINT: 'http://127.0.0.1:9000' }).offsite.configured).toBe(true);
    for (const bad of ['http://169.254.169.254', 'http://10.0.0.5:9000', 'https://x.example/bucket', 'ftp://x.example']) {
      const c = loadConfig({ ...base, ...r2, MEDLEVO_R2_ENDPOINT: bad }).offsite;
      expect(c.configured, bad).toBe(false);
      expect(c.endpoint, bad).toBeNull();
    }
  });
});
