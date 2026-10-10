// Shared locations and the global-setup → worker hand-off for the E2E harness.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_DIR = join(REPO_ROOT, 'e2e');
/** throwaway server data dirs (git-ignored via `.tmp/`) */
export const E2E_TMP_DIR = join(E2E_DIR, '.tmp');
/** screenshots + server logs + Playwright outputDir (git-ignored) */
export const E2E_ARTIFACTS_DIR = join(E2E_DIR, '.artifacts');
export const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden');
export const WEB_DIR = join(REPO_ROOT, 'apps', 'web');
export const WEB_DIST_DIR = join(WEB_DIR, 'dist');
export const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');

/** Environment variable that carries `{ [projectName]: baseURL }` from global setup to the workers. */
export const SERVERS_ENV = 'MEDLEVO_E2E_SERVERS';

export interface E2eServerInfo {
  project: string;
  baseURL: string;
  dataDir: string | null;
  logFile: string | null;
}

/** The server global setup started for this project (or the external one from E2E_BASE_URL). */
export function serverFor(project: string): E2eServerInfo {
  const raw = process.env[SERVERS_ENV];
  if (!raw) throw new Error(`${SERVERS_ENV} is not set — run the tests through \`npm run e2e\` (playwright.config.ts global setup).`);
  const servers = JSON.parse(raw) as Record<string, E2eServerInfo>;
  const info = servers[project];
  if (!info) throw new Error(`no E2E server was started for project «${project}» (have: ${Object.keys(servers).join(', ')})`);
  return info;
}
