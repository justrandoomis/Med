// Global setup: build the web app when needed, then start one REAL server per project (isolated data dir, free port)
// and hand the URLs to the workers through MEDLEVO_E2E_SERVERS. The returned function is Playwright's global teardown.
//
// Environment knobs (see e2e/README.md):
//   E2E_BUILD=1          always rebuild apps/web/dist first      E2E_BUILD=0  never build (use dist as is)
//   E2E_BASE_URL=<url>   use an already running server for every project (nothing is started or built)
//   E2E_KEEP_DATA=1      keep the throwaway data dirs under e2e/.tmp after the run
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { E2E_ARTIFACTS_DIR, E2E_TMP_DIR, REPO_ROOT, SERVERS_ENV, WEB_DIR, WEB_DIST_DIR, type E2eServerInfo } from './paths';
import { startServer, type RunningServer } from './server';

/** newest mtime (ms) of the files the web build depends on */
function newestSourceMtime(): number {
  let newest = 0;
  const walk = (p: string) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (name !== 'node_modules' && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) walk(join(p, name));
    } else newest = Math.max(newest, st.mtimeMs);
  };
  for (const p of [join(WEB_DIR, 'src'), join(WEB_DIR, 'public'), join(WEB_DIR, 'index.html'), join(WEB_DIR, 'vite.config.ts'), join(REPO_ROOT, 'packages', 'shared', 'src')]) walk(p);
  return newest;
}

function ensureWebBuild(): void {
  const index = join(WEB_DIST_DIR, 'index.html');
  const flag = process.env.E2E_BUILD;
  const missing = !existsSync(index);
  if (flag === '0') {
    if (missing) throw new Error('apps/web/dist is missing and E2E_BUILD=0 forbids building it.');
    return;
  }
  const stale = !missing && newestSourceMtime() > statSync(index).mtimeMs;
  if (!missing && !stale && flag !== '1') return;
  const why = missing ? 'apps/web/dist is missing' : flag === '1' ? 'E2E_BUILD=1' : 'web sources are newer than apps/web/dist';
  process.stdout.write(`[e2e] building the web app (${why}) …\n`);
  const res = spawnSync('npm', ['run', 'build', '-w', '@medlevo/web'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  mkdirSync(E2E_ARTIFACTS_DIR, { recursive: true });
  writeFileSync(join(E2E_ARTIFACTS_DIR, 'web-build.log'), output);
  if (res.status !== 0) throw new Error(`web build failed (exit ${res.status ?? res.signal}); full log in e2e/.artifacts/web-build.log:\n${output.slice(-3000)}`);
  process.stdout.write('[e2e] web app built (log: e2e/.artifacts/web-build.log)\n');
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const projects = config.projects.map((p) => p.name);
  const external = process.env.E2E_BASE_URL?.replace(/\/+$/, '');
  if (external) {
    const servers: Record<string, E2eServerInfo> = {};
    for (const project of projects) servers[project] = { project, baseURL: external, dataDir: null, logFile: null };
    process.env[SERVERS_ENV] = JSON.stringify(servers);
    process.stdout.write(`[e2e] using the running server at ${external} for ${projects.join(', ')}\n`);
    return async () => {};
  }

  ensureWebBuild();
  const runDir = join(E2E_TMP_DIR, `run-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const running: RunningServer[] = [];
  // never leave a server behind if the runner dies without calling teardown
  const killAll = () => running.forEach((s) => s.child.exitCode === null && s.child.kill('SIGKILL'));
  process.once('exit', killAll);

  try {
    for (const project of projects) {
      // one server + data dir per project: each project starts from an empty install (first-run setup included)
      running.push(await startServer(project, join(runDir, project)));
    }
  } catch (e) {
    await Promise.all(running.map((s) => s.stop()));
    throw e;
  }
  const servers: Record<string, E2eServerInfo> = {};
  for (const s of running) servers[s.project] = { project: s.project, baseURL: s.baseURL, dataDir: s.dataDir, logFile: s.logFile };
  process.env[SERVERS_ENV] = JSON.stringify(servers);
  for (const s of running) process.stdout.write(`[e2e] ${s.project}: ${s.baseURL} (log ${s.logFile})\n`);

  return async () => {
    await Promise.all(running.map((s) => s.stop()));
    process.removeListener('exit', killAll);
    if (process.env.E2E_KEEP_DATA === '1') process.stdout.write(`[e2e] data kept in ${runDir}\n`);
    else rmSync(runDir, { recursive: true, force: true });
  };
}
