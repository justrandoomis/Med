// MedLevo — the owner migration (ADR-0003 §5; P1-T1 step 3): `npm run migrate:multi-user -- <action> [options]`
//
//   --dry-run   (default) what the migration would do; changes nothing
//   --apply     start it: verified backup (+ encrypted R2 copy when configured) → user #1 → move the database byte for
//               byte → commit. Refused when already migrated or a migration is in progress
//   --resume    continue an unfinished migration from its last completed step (also what the server does at boot)
//   --rollback  move the vault back to medlevo.sqlite and set the multi-user files aside (while no base migration has
//               been applied since); resumable
//   --status    the journal
// Options: --data-dir <dir> · --skip-offsite (do not copy the step-0 backup to R2) · --no-verify-boot (skip the boot of
// the restored backup copy; NOT for the owner's real data) · --json (machine-readable output)
//
// On Render the server runs in the same container as the Shell, so --apply / --resume / --rollback refuse while it is
// up (they never move files under a running server): there, use the page /api/maintenance (or the variable
// MEDLEVO_OWNER_MIGRATION=apply|rollback and a restart). --dry-run and --status always work.
// Exit codes: 0 done · 1 failed (the reason is printed; nothing is lost) · 2 refused / usage.
import { isAbsolute, resolve } from 'node:path';
import { loadConfig, loadDotEnv } from '../config';
import { migrationStatus, OwnerMigrationError, planOwnerMigration, rollbackOwnerMigration, runOwnerMigration, stepLabelAr } from '../system/ownerMigration';
import { testPauseHook } from '../system/testHooks';

const HELP = `MedLevo — owner migration to the multi-user layout (ADR-0003 §5)
Usage: npm run migrate:multi-user -- [--dry-run | --apply | --resume | --rollback | --status] [--data-dir <dir>] [--skip-offsite] [--json]
  --dry-run    report what would happen (default); changes nothing
  --apply      back up, verify, move the single-owner database to user #1's vault (byte for byte), commit
  --resume     continue an unfinished migration
  --rollback   undo it (vault → medlevo.sqlite; multi-user files set aside, never deleted)
  --status     print the migration journal
Never runs while the server is running on the same data directory (use /api/maintenance there).`;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`);
  return v;
}

const fromInitCwd = (p: string) => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  loadDotEnv();
  const dataDirArg = arg(argv, '--data-dir');
  const env = { ...process.env, ...(dataDirArg ? { MEDLEVO_DATA_DIR: fromInitCwd(dataDirArg) } : {}) };
  const config = loadConfig(env, { cwd: process.env.INIT_CWD ?? process.cwd() });
  const json = argv.includes('--json');
  const print = (o: unknown, text: string) => process.stdout.write(json ? `${JSON.stringify(o, null, 2)}\n` : `${text}\n`);
  const action = (['--apply', '--resume', '--rollback', '--status', '--dry-run'] as const).find((a) => argv.includes(a)) ?? '--dry-run';

  if (action === '--status') {
    const s = migrationStatus(config);
    print(s, [`DATA_DIR: ${config.dataDir}`, `state: ${s.state} · journal: ${s.journal}`, ...s.lines.map((l) => `  ${new Date(l.at).toISOString()}  ${l.step}:${l.status}  ${stepLabelAr(l.step)}`), s.last_failure ? `last failure: ${s.last_failure.code} — ${s.last_failure.reason_ar}` : ''].join('\n'));
    return 0;
  }
  if (action === '--dry-run') {
    const r = planOwnerMigration(config);
    print(r, [
      `MedLevo owner migration — DRY RUN (nothing changed) — DATA_DIR ${config.dataDir}`,
      `state: ${r.state} · journal: ${r.journal} · can apply: ${r.can_apply ? 'yes' : 'no'}`,
      r.legacy ? `owner: ${r.legacy.owner_username ?? '(none)'} · database ${r.legacy.size} bytes, ${r.legacy.tables} tables, ${r.legacy.rows} rows · files ${r.legacy.files.count} (${r.legacy.files.bytes} bytes, ${r.legacy.files.missing} missing) · active sessions ${r.legacy.active_sessions} · device ids ${r.legacy.device_ids} · unfinished jobs ${r.legacy.unfinished_jobs}` : 'no single-owner database',
      `disk: free ${r.disk.free_bytes ?? '?'} bytes, needed ≈ ${r.disk.needed_bytes} bytes · off-site (R2): ${r.offsite.configured ? 'configured' : 'not configured'}`,
      ...r.problems_ar.map((p) => `PROBLEM: ${p}`),
      ...r.warnings_ar.map((w) => `note: ${w}`),
    ].join('\n'));
    return r.can_apply || r.state === 'migration_in_progress' ? 0 : 2;
  }
  const started = Date.now();
  if (action === '--rollback') {
    const r = await rollbackOwnerMigration({ config, hooks: testPauseHook() });
    print(r, `Rolled back in ${((Date.now() - started) / 1000).toFixed(1)} s: ${r.movedBack ? 'the vault is medlevo.sqlite again' : 'the database had not been moved'}${r.passwordCopiedBack ? '; the current password was copied back' : ''}.\nSet aside (never deleted): ${r.setAside}\nNow deploy the previous release; it reads medlevo.sqlite unchanged.`);
    return 0;
  }
  let lastStep = '';
  const out = await runOwnerMigration({
    config,
    mode: action === '--apply' ? 'apply' : 'resume',
    skipOffsite: argv.includes('--skip-offsite'),
    verifyBoot: !argv.includes('--no-verify-boot'),
    hooks: testPauseHook(),
    progress: (p) => {
      if (json || p.step === lastStep) return;
      lastStep = p.step;
      process.stdout.write(`  · ${p.step} — ${p.label_ar}\n`);
    },
  });
  print(out, [
    `Owner migration complete in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
    `User #1: ${out.username} (${out.userId}) · vault ${out.vaultId} (${out.dbFile}) — same sha256 as medlevo.sqlite: ${out.reference.sha256}`,
    `Backup: ${out.backup.path} (sha256 ${out.backup.sha256}, verified)`,
    'key' in out.offsite ? `Off-site copy: ${out.offsite.key}` : `Off-site copy: skipped (${out.offsite.skipped})`,
    `Sessions ${out.counts.sessions} · devices ${out.counts.devices} · blobs ${out.counts.blobs} · unfinished jobs ${out.counts.jobs}`,
    'Start the server: signed-in devices stay signed in; the old password works.',
  ].join('\n'));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof OwnerMigrationError) {
      process.stderr.write(`MedLevo owner migration: ${e.reasonAr}\n(${e.code}${e.retryable ? ', retryable: --resume' : ''})\n`);
      process.exit(['ALREADY_MIGRATED', 'IN_PROGRESS', 'NOTHING_TO_MIGRATE', 'NO_JOURNAL', 'SERVER_RUNNING', 'AMBIGUOUS_LAYOUT', 'ROLLBACK_IN_PROGRESS', 'OTHER_ACCOUNTS', 'BASE_MIGRATION_SINCE'].includes(e.code) ? 2 : 1);
    }
    process.stderr.write(`MedLevo owner migration FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\nNothing was deleted; run --status, then --resume or --rollback.\n`);
    process.exit(1);
  });
