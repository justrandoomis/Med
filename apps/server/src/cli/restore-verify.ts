// MedLevo restore verification / restore CLI (§49, AC-30).
//   npm run restore:verify -- <archive.tar.gz>                       verify in a SEPARATE temporary directory
//   npm run restore:verify -- <archive.tar.gz> --target <empty dir>  verify, then restore into that empty directory
// Verification: safe extraction (path checks + size/ratio limits), manifest, database and per-file sha256, file
// store completeness, PRAGMA integrity_check / foreign_key_check, migrations vs this build, row counts vs manifest,
// FTS integrity, relational samples (sources→versions→pages, annotations→targets, questions→occurrences, links,
// sessions, review events→cards) and a boot of the app on the restored directory.
// A restore NEVER overwrites data: --target must not exist or be empty, and may not be the live data directory.
// Exit codes: 0 every check passed (and restored, with --target) · 1 a check failed (nothing restored) · 2 usage.
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RestoreReport } from '@medlevo/shared';
import { loadConfig, loadDotEnv } from '../config';
import { applyRestore, DEFAULT_RESTORE_LIMITS, RestoreTargetError, verifyBackup } from '../modules/data/restore';

const HELP = `MedLevo restore verification
Usage:
  npm run restore:verify -- <archive.tar.gz> [options]                    verify only (temporary directory, removed afterwards)
  npm run restore:verify -- <archive.tar.gz> --target <empty dir> [opts]  verify, then restore into the empty directory
Options:
  --target <dir>    restore into this directory (must not exist or be empty; never the live data directory)
  --work-dir <dir>  parent of the temporary verification directory (default: the OS temp directory)
  --keep            keep the verified copy (prints where)
  --no-boot         skip booting the app on the restored copy
  --json <file>     also write the report as JSON
  --max-gb <n>      maximum uncompressed size accepted (default 64)
  --accept-missing-files
                    restore even though some files were ALREADY missing or damaged when the backup was made
                    (listed in its manifest): your writing and all other data come back, those files do not.
                    Any other missing or damaged file still fails.`;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`);
  return v;
}

const fromInitCwd = (p: string) => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p));

/** how many files were restored without their content because of --accept-missing-files (0 when none) */
function acceptedMissing(report: RestoreReport): number {
  const fc = report.checks.find((c) => c.name === 'files_complete');
  const d = fc?.details as { accepted?: boolean; file_ids?: string[] } | undefined;
  return d?.accepted ? (d.file_ids?.length ?? 0) : 0;
}

function print(report: RestoreReport): void {
  const lines = [
    '',
    `Backup:   ${report.backup_id ?? '?'}  (app ${report.app_version ?? '?'}, created ${report.backup_created_at ? new Date(report.backup_created_at).toISOString() : '?'})`,
    ...report.checks.map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(24)} ${c.detail_ar}`),
    '',
    report.ok
      ? acceptedMissing(report)
        ? `RESULT: PASS — every check passed; ${acceptedMissing(report)} file(s) already missing at backup time were accepted (--accept-missing-files) and will not open.`
        : 'RESULT: PASS — every check passed.'
      : 'RESULT: FAIL — see the failed checks above. Nothing was restored.',
  ];
  if (report.restored_to) lines.push(`Restored into: ${report.restored_to}`, 'Start the server with MEDLEVO_DATA_DIR pointing there. All devices must sign in again; they will re-sync automatically.');
  if (report.work_dir) lines.push(`Verified copy kept at: ${report.work_dir}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const archive = argv.find((a, i) => !a.startsWith('--') && !['--target', '--work-dir', '--json', '--max-gb'].includes(argv[i - 1] ?? ''));
  if (!archive) {
    process.stderr.write(`${HELP}\n`);
    return 2;
  }
  const target = arg(argv, '--target');
  const workDir = arg(argv, '--work-dir');
  const jsonOut = arg(argv, '--json');
  const maxGb = Number(arg(argv, '--max-gb') ?? '64');
  if (!Number.isFinite(maxGb) || maxGb <= 0) {
    process.stderr.write('--max-gb must be a positive number\n');
    return 2;
  }
  const limits = { ...DEFAULT_RESTORE_LIMITS, maxTotalBytes: maxGb * 1024 ** 3, maxEntryBytes: maxGb * 1024 ** 3 };
  const opts = {
    workDir: workDir ? fromInitCwd(workDir) : undefined,
    keep: argv.includes('--keep'),
    bootCheck: !argv.includes('--no-boot'),
    limits,
    acceptMissingFiles: argv.includes('--accept-missing-files'),
  };

  let liveDataDir: string | null = null;
  try {
    loadDotEnv();
    liveDataDir = loadConfig(process.env, { cwd: process.env.INIT_CWD ?? process.cwd() }).dataDir;
  } catch {
    liveDataDir = null;
  }

  process.stdout.write(`MedLevo restore${target ? '' : ' verification'}: ${fromInitCwd(archive)}\n`);
  let report: RestoreReport;
  try {
    report = target
      ? (await applyRestore(fromInitCwd(archive), fromInitCwd(target), { ...opts, liveDataDir })).report
      : (await verifyBackup(fromInitCwd(archive), opts)).report;
  } catch (e) {
    if (e instanceof RestoreTargetError) {
      process.stderr.write(`Refused: ${e.reasonAr}\n`);
      return 2;
    }
    throw e;
  }
  print(report);
  if (jsonOut) writeFileSync(fromInitCwd(jsonOut), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`MedLevo restore:verify failed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
