// Production setup, exercised (§49, §61, track F5): the REAL server entry point (`src/index.ts`, NODE_ENV=production,
// migrations, static SPA) runs behind a local TLS-terminating Node reverse proxy with a self-signed certificate made at
// test time (openssl). Through https only, the test checks what docs/DEPLOYMENT.md promises:
//   * Secure + HttpOnly + SameSite=Strict session cookie and HSTS when the origin is https;
//   * MEDLEVO_TRUST_PROXY=true: the client address comes from X-Forwarded-For (sessions show it), and the first-run
//     setup requires the one-time token printed in the server log; =false: X-Forwarded-For is ignored (the proxy's
//     address is recorded) and a chosen MEDLEVO_SETUP_TOKEN is still enforced;
//   * Origin / CSRF checks: no CSRF header, a foreign Origin, an http:// Origin for an https site, Sec-Fetch-Site
//     cross-site → 403; the exact https origin → accepted.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';

const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
// the public client address the reverse proxy reports (nginx: proxy_set_header X-Forwarded-For $remote_addr)
const CLIENT_IP = '198.51.100.7';
const SERVER_ENTRY = join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Backend {
  child: ChildProcess;
  port: number;
  log: () => string;
  stop: () => Promise<void>;
}

async function startBackend(dir: string, env: Record<string, string>): Promise<Backend> {
  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', SERVER_ENTRY], {
    cwd: join(REPO_ROOT, 'apps', 'server'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MEDLEVO_DATA_DIR: join(dir, 'data'),
      MEDLEVO_HOST: '127.0.0.1',
      MEDLEVO_PORT: String(port),
      MEDLEVO_LOG_LEVEL: 'info',
      MEDLEVO_SCRYPT_LOG_N: '12',
      MEDLEVO_WEB_DIST: join(dir, 'web'),
      ANTHROPIC_API_KEY: '',
      MEDLEVO_COOKIE_SECURE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out.slice(-3000)}`);
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        r.on('error', () => resolve(false));
      });
      if (ok) break;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server not healthy in 60 s:\n${out.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    child,
    port,
    log: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}

/** A TLS-terminating reverse proxy, as nginx / Caddy would be: it OVERWRITES X-Forwarded-* (never appends). */
function startProxy(port: number, backendPort: number, key: Buffer, cert: Buffer): Promise<https.Server> {
  const server = https.createServer({ key, cert }, (req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': CLIENT_IP, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' };
    const up = http.request({ host: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

function call(port: number, ca: Buffer, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        servername: 'localhost',
        port,
        method,
        path,
        ca,
        headers: { host: `localhost:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as Record<string, unknown> }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieOf = (r: Res) => {
  const raw = r.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).find((c) => c.startsWith('medlevo_session=')) ?? '';
};

describe.skipIf(!OPENSSL)('behind a TLS-terminating reverse proxy (self-signed cert made at test time)', () => {
  let dir: string;
  let key: Buffer;
  let cert: Buffer;
  const started: Array<{ stop: () => Promise<void> } | https.Server> = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'medlevo-tls-'));
    const r = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'));
  });

  afterAll(async () => {
    for (const s of started.reverse()) {
      if (s instanceof https.Server) await new Promise<void>((r) => s.close(() => r()));
      else await s.stop();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function stack(name: string, env: (origin: string) => Record<string, string>) {
    const base = join(dir, name);
    mkdirSync(join(base, 'web'), { recursive: true });
    writeFileSync(join(base, 'web', 'index.html'), '<!doctype html><html lang="ar" dir="rtl"><title>MedLevo</title><div id="root"></div></html>');
    const proxyPort = await freePort();
    const origin = `https://localhost:${proxyPort}`;
    const backend = await startBackend(base, { MEDLEVO_ORIGIN: origin, ...env(origin) });
    started.push(backend);
    const proxy = await startProxy(proxyPort, backend.port, key, cert);
    started.push(proxy);
    return { proxyPort, origin, backend, req: (method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown }) => call(proxyPort, cert, method, path, opts) };
  }

  it('MEDLEVO_TRUST_PROXY=true: one-time setup token from the log, Secure cookie + HSTS, client IP from X-Forwarded-For, CSRF / Origin enforced', async () => {
    const s = await stack('trusted', () => ({ MEDLEVO_TRUST_PROXY: 'true', MEDLEVO_SETUP_TOKEN: '' }));
    const health = await s.req('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(health.headers['content-security-policy']).toContain("default-src 'none'");
    const spa = await s.req('GET', '/library');
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('<div id="root">');

    const status = (await s.req('GET', '/api/auth/status')).json();
    expect(status).toMatchObject({ setup_required: true, setup_token_required: true });
    // the token is printed to the server log at boot (never stored)
    const token = /setup token: ([A-Z2-9]{4}(?:-[A-Z2-9]{4})+)/.exec(s.backend.log())?.[1];
    expect(token, 'setup token in the server log').toBeTruthy();

    const owner = { username: 'owner', password: 'a-long-test-password-1' };
    const csrf = { 'x-medlevo-csrf': '1', origin: s.origin };
    const noToken = await s.req('POST', '/api/auth/setup', { headers: csrf, body: owner });
    expect(noToken.status).toBe(403);
    expect(JSON.stringify(noToken.json())).toContain('setup_token_required');
    expect((await s.req('POST', '/api/auth/setup', { headers: csrf, body: { ...owner, setup_token: 'WRONG-TOKEN-ABCD' } })).status).toBe(403);
    const ok = await s.req('POST', '/api/auth/setup', { headers: csrf, body: { ...owner, setup_token: token } });
    expect(ok.status, ok.body).toBe(200);
    const setCookie = cookieOf(ok);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; SameSite=Strict/);
    expect(setCookie).toMatch(/; Path=\//);
    const cookie = setCookie.split(';')[0]!;
    // a second setup is refused (the owner exists; the token was consumed)
    expect((await s.req('POST', '/api/auth/setup', { headers: csrf, body: { ...owner, setup_token: token } })).status).toBeGreaterThanOrEqual(400);

    // trust proxy: the session records the client address the proxy reported
    const sessions = (await s.req('GET', '/api/auth/sessions', { headers: { cookie } })).json() as { sessions: Array<{ ip: string | null; current: boolean }> };
    expect(sessions.sessions.find((x) => x.current)?.ip).toBe(CLIENT_IP);

    // CSRF / Origin on a mutation, with a valid session
    const body = { errors: [{ kind: 'error', message: 'tls test' }] };
    const post = (headers: Record<string, string>) => s.req('POST', '/api/control/client-errors', { headers: { cookie, ...headers }, body });
    expect((await post({ origin: s.origin })).status).toBe(403); // no CSRF header
    expect((await post({ 'x-medlevo-csrf': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'x-medlevo-csrf': '1', origin: `http://localhost:${s.proxyPort}` })).status).toBe(403); // http:// for an https site
    expect((await post({ 'x-medlevo-csrf': '1', origin: s.origin, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'x-medlevo-csrf': '1', origin: s.origin, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // and the login cookie is Secure too
    const login = await s.req('POST', '/api/auth/login', { headers: csrf, body: owner });
    expect(login.status).toBe(200);
    expect(cookieOf(login)).toMatch(/; Secure/);
  }, 120_000);

  it('MEDLEVO_TRUST_PROXY=false: X-Forwarded-For is ignored (the proxy address is recorded); a chosen MEDLEVO_SETUP_TOKEN is enforced', async () => {
    const chosen = 'my-chosen-setup-token-0123456789';
    const s = await stack('untrusted', () => ({ MEDLEVO_TRUST_PROXY: 'false', MEDLEVO_SETUP_TOKEN: chosen }));
    expect((await s.req('GET', '/api/auth/status')).json()).toMatchObject({ setup_required: true, setup_token_required: true });
    expect(s.backend.log()).not.toContain(chosen); // a chosen token is never printed
    const owner = { username: 'owner', password: 'a-long-test-password-1' };
    const csrf = { 'x-medlevo-csrf': '1', origin: s.origin };
    expect((await s.req('POST', '/api/auth/setup', { headers: csrf, body: { ...owner, setup_token: 'nope' } })).status).toBe(403);
    const ok = await s.req('POST', '/api/auth/setup', { headers: csrf, body: { ...owner, setup_token: chosen } });
    expect(ok.status, ok.body).toBe(200);
    expect(cookieOf(ok)).toMatch(/; Secure/); // https origin → Secure by default
    const cookie = cookieOf(ok).split(';')[0]!;
    const sessions = (await s.req('GET', '/api/auth/sessions', { headers: { cookie } })).json() as { sessions: Array<{ ip: string | null; current: boolean }> };
    const ip = sessions.sessions.find((x) => x.current)?.ip ?? '';
    expect(ip).not.toBe(CLIENT_IP);
    expect(ip).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  }, 120_000);
});
