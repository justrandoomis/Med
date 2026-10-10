// Start / stop a REAL MedLevo server for the E2E run: production mode, built web app, throwaway data dir, free port.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { E2E_ARTIFACTS_DIR, REPO_ROOT, SERVER_DIR, WEB_DIST_DIR, type E2eServerInfo } from './paths';

export interface RunningServer extends E2eServerInfo {
  child: ChildProcess;
  stop(): Promise<void>;
}

/** A free TCP port on the loopback interface (tiny race between close and the server's listen; fine for tests). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('no free port'))));
    });
  });
}

function tail(file: string, chars = 4000): string {
  try {
    return readFileSync(file, 'utf8').slice(-chars);
  } catch {
    return '(no server log)';
  }
}

export async function startServer(project: string, dataDir: string): Promise<RunningServer> {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  mkdirSync(E2E_ARTIFACTS_DIR, { recursive: true });
  const logFile = join(E2E_ARTIFACTS_DIR, `server-${project}.log`);
  const log = createWriteStream(logFile, { flags: 'w' });

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(SERVER_DIR, 'src', 'index.ts')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MEDLEVO_DATA_DIR: dataDir,
      MEDLEVO_HOST: '127.0.0.1',
      MEDLEVO_PORT: String(port),
      // the browser opens exactly this origin → CSRF Origin check matches; loopback → no first-run setup token
      MEDLEVO_ORIGIN: baseURL,
      MEDLEVO_WEB_DIST: WEB_DIST_DIR,
      MEDLEVO_LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL || 'info',
      // honest product state: no AI provider exists here. An empty value wins over a developer's .env
      // (process.loadEnvFile never overrides variables that are already set).
      ANTHROPIC_API_KEY: '',
      MEDLEVO_SETUP_TOKEN: '',
      MEDLEVO_ALLOW_EXTERNAL_FETCH: 'false',
      MEDLEVO_TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let exited: number | string | null = null;
  child.once('exit', (code, signal) => (exited = code ?? signal ?? 'unknown'));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited !== null) throw new Error(`MedLevo server for «${project}» exited (${exited}) before it was ready:\n${tail(logFile)}`);
    try {
      const res = await fetch(`${baseURL}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`MedLevo server for «${project}» did not become healthy in 90 s:\n${tail(logFile)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const stop = async () => {
    if (exited === null) {
      const done = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill('SIGTERM'); // graceful: stops jobs (re-queues running ones) and closes the database
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await done;
      clearTimeout(timer);
    }
    await new Promise<void>((r) => log.end(() => r()));
  };

  return { project, baseURL, dataDir, logFile: logFile.replace(`${REPO_ROOT}/`, ''), child, stop };
}
