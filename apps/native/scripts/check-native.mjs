#!/usr/bin/env node
// Static checks of the native shell skeleton (Academic OS P1-T2 step 2; ADR-0005 B.1, B.5; BUILD_PLAN §3.4 «Native
// skeleton: the Capacitor project and the CI workflow files pass static checks here»).
//
// Nothing here builds, signs or runs an iOS or Android app — that needs Xcode on a macOS runner, the Android SDK and
// the owner's signing material (GitHub encrypted secrets), none of which exist in this container. What it does check:
//   * capacitor.config.json: a well-formed config that ships the bundled web app (never a remote URL), over https,
//     without mixed content or web debugging in release builds;
//   * package.json: private, one Capacitor major, and NOT an npm workspace of the repository (root installs and the
//     web/server builds stay exactly as they are);
//   * .github/workflows/native-{ios,android}.yml: run only when asked (workflow_dispatch), read-only token, the static
//     job first, the build on the right runner, actions pinned, secrets only by name.
//
// Usage: node apps/native/scripts/check-native.mjs   (exit code 1 when a check fails)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const NATIVE_DIR = resolve(here, '..');
export const REPO_ROOT = resolve(NATIVE_DIR, '../..');

const CONFIG_KEYS = new Set(['appId', 'appName', 'webDir', 'loggingBehavior', 'server', 'ios', 'android', 'plugins', 'backgroundColor', 'zoomEnabled', 'initialFocus']);
const APP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

function readJson(file, problems) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${file}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

export function checkConfig(cfg) {
  const p = [];
  if (!cfg || typeof cfg !== 'object') return ['capacitor.config.json: not an object'];
  for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.has(k)) p.push(`capacitor.config.json: unknown key «${k}»`);
  if (typeof cfg.appId !== 'string' || !APP_ID_RE.test(cfg.appId)) p.push('capacitor.config.json: appId must be a reverse-DNS id (lower case, e.g. ai.medlevo.app)');
  if (typeof cfg.appName !== 'string' || !cfg.appName.trim()) p.push('capacitor.config.json: appName is required');
  if (cfg.webDir !== '../web/dist') p.push('capacitor.config.json: webDir must be ../web/dist (the same bundle the PWA serves)');
  const server = cfg.server ?? {};
  if ('url' in server) p.push('capacitor.config.json: server.url loads the app from the network — store builds must ship the bundled web app');
  if (server.cleartext === true) p.push('capacitor.config.json: server.cleartext must not be enabled');
  if (server.androidScheme !== 'https') p.push('capacitor.config.json: server.androidScheme must be https (secure context: service worker, crypto, microphone)');
  const android = cfg.android ?? {};
  if (android.allowMixedContent !== false) p.push('capacitor.config.json: android.allowMixedContent must be false');
  if (android.webContentsDebuggingEnabled === true) p.push('capacitor.config.json: android.webContentsDebuggingEnabled must not be true in the committed config');
  if (cfg.loggingBehavior !== undefined && !['none', 'debug', 'production'].includes(cfg.loggingBehavior)) p.push('capacitor.config.json: loggingBehavior must be none, debug or production');
  if (cfg.ios?.contentInset !== undefined && !['automatic', 'scrollableAxes', 'never', 'always'].includes(cfg.ios.contentInset)) p.push('capacitor.config.json: ios.contentInset is not a Capacitor value');
  if (cfg.plugins !== undefined && (typeof cfg.plugins !== 'object' || Array.isArray(cfg.plugins))) p.push('capacitor.config.json: plugins must be an object');
  return p;
}

export function checkPackage(pkg, rootPkg) {
  const p = [];
  if (!pkg) return ['apps/native/package.json: missing'];
  if (pkg.private !== true) p.push('apps/native/package.json: must be private (never published)');
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const cap = Object.entries(deps).filter(([n]) => n.startsWith('@capacitor/'));
  for (const need of ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']) if (!(need in deps)) p.push(`apps/native/package.json: ${need} is missing`);
  const majors = new Set(cap.map(([, v]) => String(v).replace(/^[^\d]*/, '').split('.')[0]));
  if (majors.size > 1) p.push(`apps/native/package.json: Capacitor packages on different majors (${[...majors].join(', ')})`);
  const ws = rootPkg?.workspaces ?? [];
  if (ws.some((w) => w === 'apps/native' || w === 'apps/*' || w === 'apps/**')) p.push('package.json (root): apps/native must not be an npm workspace (root installs must stay as they are)');
  return p;
}

const PINNED_ACTION_RE = /^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/;

export function checkWorkflow(name, wf, platform) {
  const p = [];
  if (!wf || typeof wf !== 'object') return [`${name}: not a YAML mapping`];
  const on = wf.on ?? wf[true]; // YAML 1.1 reads a bare `on:` key as true
  const triggers = on && typeof on === 'object' ? Object.keys(on) : typeof on === 'string' ? [on] : [];
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') p.push(`${name}: must run only when asked (on: workflow_dispatch), found ${JSON.stringify(triggers)}`);
  if (wf.permissions?.contents !== 'read') p.push(`${name}: permissions.contents must be read`);
  const jobs = wf.jobs ?? {};
  const st = jobs['static-checks'];
  if (!st) p.push(`${name}: a static-checks job is required`);
  else if (!String(st['runs-on'] ?? '').startsWith('ubuntu')) p.push(`${name}: static-checks runs on ubuntu`);
  const build = jobs.build;
  if (!build) p.push(`${name}: a build job is required`);
  else {
    const needs = [build.needs].flat();
    if (!needs.includes('static-checks')) p.push(`${name}: build must need static-checks`);
    const runner = String(build['runs-on'] ?? '');
    if (platform === 'ios' && !runner.startsWith('macos')) p.push(`${name}: the iOS build runs on a macOS runner (Xcode)`);
    if (platform === 'android' && !runner.startsWith('ubuntu')) p.push(`${name}: the Android build runs on ubuntu`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job?.steps ?? []) {
      if (step.uses && !PINNED_ACTION_RE.test(step.uses)) p.push(`${name}: job ${jobName} uses an unpinned action «${step.uses}»`);
      const text = JSON.stringify(step);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|"password"\s*:\s*"[^$"][^"]*"/i.test(text)) p.push(`${name}: job ${jobName} carries what looks like literal signing material — secrets only by name`);
    }
  }
  return p;
}

async function loadYaml(text, file, problems) {
  try {
    const yaml = await import('js-yaml');
    return (yaml.load ?? yaml.default.load)(text);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ERR_MODULE_NOT_FOUND') {
      problems.push(`${file}: js-yaml is not installed (run npm ci at the repository root first)`);
      return null;
    }
    problems.push(`${file}: not valid YAML (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

export async function checkNative(root = REPO_ROOT) {
  const problems = [];
  const nativeDir = join(root, 'apps/native');
  problems.push(...checkConfig(readJson(join(nativeDir, 'capacitor.config.json'), problems)));
  problems.push(...checkPackage(readJson(join(nativeDir, 'package.json'), problems), readJson(join(root, 'package.json'), problems)));
  for (const [file, platform] of [
    ['.github/workflows/native-ios.yml', 'ios'],
    ['.github/workflows/native-android.yml', 'android'],
  ]) {
    const full = join(root, file);
    if (!existsSync(full)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const wf = await loadYaml(readFileSync(full, 'utf8'), file, problems);
    if (wf) problems.push(...checkWorkflow(file, wf, platform));
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkNative();
  if (problems.length) {
    process.stderr.write(`native skeleton: ${problems.length} problem(s)\n${problems.map((x) => `  - ${x}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('native skeleton: capacitor.config.json, package.json and the native workflows pass the static checks (nothing was built or signed)\n');
}
