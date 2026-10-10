// A REAL MedLevo server process for resilience tests (kill -9 / restart on the same data dir). Production mode,
// loopback, throwaway data dir, no AI key. Same knobs as the E2E harness (e2e/support/server.ts), without the web app.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CSRF = { 'x-medlevo-csrf': '1' } as const;

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => (port ? ok(port) : fail(new Error('no free port'))));
    });
  });
}

export interface ServerProcess {
  baseURL: string;
  child: ChildProcess;
  /** wall-clock ms from spawn until /api/health answered */
  bootMs: number;
  exited: () => boolean;
  /** SIGKILL: no shutdown hook runs (a crash / power loss of the process) */
  kill9(): Promise<void>;
  /** SIGTERM: graceful stop (running jobs are re-queued, DB closed) */
  stop(): Promise<void>;
}

export async function startServerProcess(dataDir: string, port: number, logFile: string, env: Record<string, string> = {}): Promise<ServerProcess> {
  const baseURL = `http://127.0.0.1:${port}`;
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(SERVER_DIR, 'src', 'index.ts')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MEDLEVO_DATA_DIR: dataDir,
      MEDLEVO_HOST: '127.0.0.1',
      MEDLEVO_PORT: String(port),
      MEDLEVO_ORIGIN: baseURL,
      MEDLEVO_WEB_DIST: join(dataDir, 'no-web-dist'),
      MEDLEVO_LOG_LEVEL: 'info',
      ANTHROPIC_API_KEY: '',
      MEDLEVO_SETUP_TOKEN: '',
      MEDLEVO_ALLOW_EXTERNAL_FETCH: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let exitedFlag = false;
  const exitedP = new Promise<void>((r) => child.once('exit', () => ((exitedFlag = true), r())));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exitedFlag) throw new Error(`server exited during boot:\n${readFileSync(logFile, 'utf8').slice(-3000)}`);
    try {
      if ((await fetch(`${baseURL}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 90 s');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const bootMs = Date.now() - t0;
  return {
    baseURL,
    child,
    bootMs,
    exited: () => exitedFlag,
    async kill9() {
      if (!exitedFlag) child.kill('SIGKILL');
      await exitedP;
    },
    async stop() {
      if (!exitedFlag) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exitedP;
        clearTimeout(timer);
      }
      await new Promise<void>((r) => log.end(() => r()));
    },
  };
}

/** Minimal owner client (cookie + CSRF header) for a server process. */
export class Client {
  cookie = '';
  constructor(readonly baseURL: string) {}

  async call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { ...CSRF, ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseURL}${path}`, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() ?? [];
    const session = set.find((c) => c.startsWith('medlevo_session='));
    if (session) this.cookie = session.split(';')[0]!;
    return res;
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await this.call(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async owner(password = 'quiet library pages 42'): Promise<void> {
    const status = await this.json<{ setup_required: boolean }>('GET', '/api/auth/status');
    await this.json('POST', status.setup_required ? '/api/auth/setup' : '/api/auth/login', { username: 'owner', password });
  }
}
