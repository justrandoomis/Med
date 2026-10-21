// MedLevo restore from the off-site copy (PL-0) — ONE command in the Render dashboard → Shell:
//   medlevo-restore-offsite --latest
// (the Docker image installs this wrapper; elsewhere: node --import tsx apps/server/src/cli/restore-offsite.ts …)
// It lists the encrypted backups in Cloudflare R2, downloads one (resuming a broken download), decrypts and
// authenticates it with MEDLEVO_BACKUP_ENCRYPTION_KEY, runs every restore:verify check, and restores into a NEW empty
// directory beside the live data — never over it. Then the owner sets MEDLEVO_DATA_DIR to the printed directory in
// Render → Environment; Render redeploys and the server starts on the restored data. Devices re-sync by themselves.
// Exit codes: 0 every check passed (restored, or verified with --verify-only) · 1 a check failed / decryption refused
// (nothing restored) · 2 usage, configuration or a refused target.
import { chownSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig, loadDotEnv } from '../config';
import { DecryptError } from '../lib/objectstore/encryption';
import { S3Error } from '../lib/objectstore/s3';
import { describeOffsiteError } from '../modules/data/offsite';
import { listOffsite, OffsiteRestoreError, restoreFromOffsite } from '../modules/data/offsite-restore';
import { RestoreTargetError } from '../modules/data/restore';

const HELP = `MedLevo — restore from the off-site (Cloudflare R2) backup
Usage:
  medlevo-restore-offsite --list                    list the encrypted backups in R2 (newest first)
  medlevo-restore-offsite --latest                  restore the newest one into a new directory beside the data
  medlevo-restore-offsite --key <file name>         restore that one (a name from --list)
Options:
  --target <empty dir>     where to restore (default: <parent of MEDLEVO_DATA_DIR>/medlevo-restored-<time>)
  --verify-only            download, decrypt and run every check; restore nothing
  --accept-missing-files   restore although files were already missing when the backup was made (see restore:verify)
  --allow-other-disk       allow a target outside the disk of the live data (on Render it would be lost at the next deploy)
  --no-boot                skip booting the app on the restored copy
  --json <file>            also write the verification report as JSON
Nothing is ever restored over the live data. Needs the same MEDLEVO_R2_* settings and MEDLEVO_BACKUP_ENCRYPTION_KEY
as the server that made the backups.`;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`);
  return v;
}

/**
 * A Render Shell session is not documented to carry the service's environment. When the off-site settings are missing
 * here but the running server (PID 1 of the container) has them, take ONLY MedLevo's own variables from it — read
 * locally from /proc (root in the container), never printed.
 */
function inheritServiceEnv(): boolean {
  if (process.env.MEDLEVO_R2_BUCKET || process.env.MEDLEVO_BACKUP_ENCRYPTION_KEY) return false;
  let raw: string;
  try {
    raw = readFileSync('/proc/1/environ', 'utf8');
  } catch {
    return false;
  }
  let n = 0;
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i < 1) continue;
    const k = kv.slice(0, i);
    if (/^(MEDLEVO_[A-Z0-9_]+|RENDER_EXTERNAL_URL|NODE_ENV)$/.test(k) && process.env[k] === undefined) {
      process.env[k] = kv.slice(i + 1);
      n++;
    }
  }
  return n > 0;
}

/** run as root (a Render Shell): give the restored tree to the owner of the live data, so the server can write it */
function chownLike(target: string, like: string): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  let uid: number;
  let gid: number;
  try {
    ({ uid, gid } = statSync(like));
  } catch {
    return;
  }
  const walk = (p: string) => {
    const st = lstatSync(p);
    chownSync(p, uid, gid);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  walk(target);
}

const human = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const fromCwd = (p: string) => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  loadDotEnv();
  if (inheritServiceEnv()) process.stdout.write('Using the off-site settings of the running MedLevo server.\n');
  const config = loadConfig(process.env, { cwd: process.env.INIT_CWD ?? process.cwd() });
  if (argv.includes('--list')) {
    const list = await listOffsite(config);
    if (list.length === 0) process.stdout.write('No off-site backups yet.\n');
    for (const o of list) process.stdout.write(`${new Date(o.createdAt).toISOString()}  ${human(o.size).padStart(9)}  ${o.fileName}\n`);
    return 0;
  }
  const key = arg(argv, '--key');
  if (!key && !argv.includes('--latest')) {
    process.stderr.write('Say which backup: --latest or --key <file name> (see --list).\n');
    return 2;
  }
  const target = arg(argv, '--target');
  const jsonOut = arg(argv, '--json');
  const res = await restoreFromOffsite(config, {
    key,
    target: target ? fromCwd(target) : null,
    verifyOnly: argv.includes('--verify-only'),
    acceptMissingFiles: argv.includes('--accept-missing-files'),
    allowOtherDisk: argv.includes('--allow-other-disk'),
    bootCheck: !argv.includes('--no-boot'),
    log: (l) => process.stdout.write(`${l}\n`),
  });
  const r = res.report;
  process.stdout.write(
    [
      '',
      `Backup:   ${res.object.fileName} (made ${new Date(res.object.createdAt).toISOString()})`,
      ...r.checks.map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(24)} ${c.detail_ar}`),
      '',
      r.ok ? 'RESULT: PASS — every check passed.' : 'RESULT: FAIL — see the failed checks above. Nothing was restored.',
      '',
    ].join('\n'),
  );
  if (jsonOut) writeFileSync(fromCwd(jsonOut), JSON.stringify(r, null, 2), { mode: 0o600 });
  if (res.restoredTo) {
    chownLike(res.restoredTo, config.dataDir);
    process.stdout.write(
      [
        `Restored into: ${res.restoredTo}`,
        'Next (from the phone): Render dashboard → your service → Environment → Add Environment Variable (or edit it if it',
        'is already there):',
        `  MEDLEVO_DATA_DIR=${res.restoredTo}`,
        'and save. Render redeploys and the server starts on the restored data. Never put MEDLEVO_DATA_DIR in render.yaml: a',
        'Blueprint sync would overwrite this setting and move the server back to the old data. The old directory stays',
        'untouched until you delete it. Every device signs in again and re-syncs by itself.',
        '',
      ].join('\n'),
    );
  }
  return r.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof OffsiteRestoreError || e instanceof RestoreTargetError) {
      process.stderr.write(`Refused: ${e.reasonAr}\n`);
      process.exit(2);
    }
    if (e instanceof DecryptError || e instanceof S3Error) {
      process.stderr.write(`FAILED: ${describeOffsiteError(e).reasonAr}\nNothing was restored.\n`);
      process.exit(1);
    }
    process.stderr.write(`MedLevo restore from R2 failed: ${e instanceof Error ? e.message : String(e)}\nNothing was restored.\n`);
    process.exit(e instanceof Error && e.name === 'ConfigError' ? 2 : 1);
  });
