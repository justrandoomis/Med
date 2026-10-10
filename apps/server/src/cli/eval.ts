// MedLevo evaluation CLI (§57): `npm run eval [-- options]`
// Builds a THROWAWAY MedLevo server (temporary data directory, removed afterwards), uploads the TEST FIXTURE files
// (fixtures/golden + fixtures/acceptance) through the real API, processes them with the real pipeline, evaluates every
// catalogue case per axis, and writes the report as JSON + Markdown. The owner's library is never touched; when the
// server's database exists (MEDLEVO_DATA_DIR) the report is also recorded there for the Control Center.
// Exit codes: 0 report written · 1 the run failed · 2 usage · 4 --compare found regressions (a regression-set case
// that passed in the baseline does not pass now) · 5 --strict and the regression set has failures or errors ·
// 6 --compare could not compare (the regression set changed — another catalogue hash — or regression cases the
// baseline passed were not evaluated in this run): «no regressions» is never reported for cases that were not compared.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { EVAL_AXES, type EvalAxis, type EvalMode, type EvalReport, type EvalSet } from '@medlevo/shared';
import { REPO_ROOT, loadConfig, loadDotEnv } from '../config';
import { openDb } from '../db/db';
import { migrate } from '../db/migrate';
import { compareReports, rateTextEn, renderCompareMarkdown, renderMarkdown } from '../modules/control/evaluation/report';
import { runEvaluation } from '../modules/control/evaluation/runner';
import { recordRun, syncCatalogue } from '../modules/control/evaluation/store';

const HELP = `MedLevo evaluation (§57)
Usage: npm run eval [-- options]
  --set=regression|tuning|all   which set to run (default: all; the two are always reported apart)
  --axis=a,b                    only these axes (${EVAL_AXES.join(', ')})
  --only=prefix,prefix          only cases whose id starts with a prefix (e.g. key.g4_)
  --mode=scripted|live          scripted (default): AI axes use the evaluation-only scripted provider and measure the
                                server's guarantees; live: the configured provider (needs ANTHROPIC_API_KEY)
  --label=<text>                a label stored with the run (e.g. "before chunker v2")
  --out=<dir>                   where to write <run>.json / <run>.md and latest.* (default: eval-reports/)
  --compare=<report.json>       compare with an earlier report (writes compare-<base>-<head>.md; exit 4 on regressions,
                                exit 6 when not comparable: another regression set, or baseline-passed regression
                                cases not evaluated in this run)
  --write-baseline              also write docs/eval/baseline.json + baseline.md (the committed reference run)
  --strict                      exit 5 when a regression-set case fails or errors
  --no-record                   do not record the run in the server's database
  --data-dir <dir>              the server's data directory (default: MEDLEVO_DATA_DIR from the environment / .env)
Fixtures are synthetic TEST FIXTURE documents; no rate here is an accuracy claim beyond these cases.`;

function opt(argv: string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1]!;
  return null;
}

function fromInitCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  loadDotEnv();
  const set = (opt(argv, 'set') ?? 'all') as EvalSet | 'all';
  const mode = (opt(argv, 'mode') ?? 'scripted') as EvalMode;
  const axes = (opt(argv, 'axis') ?? '').split(',').map((s) => s.trim()).filter(Boolean) as EvalAxis[];
  const only = (opt(argv, 'only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!['all', 'regression', 'tuning'].includes(set) || !['scripted', 'live'].includes(mode) || axes.some((a) => !(EVAL_AXES as readonly string[]).includes(a))) {
    process.stderr.write(`${HELP}\n`);
    return 2;
  }
  const outDir = fromInitCwd(opt(argv, 'out') ?? join(REPO_ROOT, 'eval-reports'));
  const label = opt(argv, 'label');
  const comparePath = opt(argv, 'compare');

  const report = await runEvaluation({ mode, set, axes, only, label, log: (l) => process.stdout.write(`${l}\n`) });
  mkdirSync(outDir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = renderMarkdown(report);
  writeFileSync(join(outDir, `${report.run_id}.json`), json);
  writeFileSync(join(outDir, `${report.run_id}.md`), md);
  copyFileSync(join(outDir, `${report.run_id}.json`), join(outDir, 'latest.json'));
  copyFileSync(join(outDir, `${report.run_id}.md`), join(outDir, 'latest.md'));
  if (argv.includes('--write-baseline')) {
    const dir = join(REPO_ROOT, 'docs', 'eval');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'baseline.json'), json);
    writeFileSync(join(dir, 'baseline.md'), md);
    process.stdout.write(`baseline written to ${dir}\n`);
  }

  process.stdout.write(`\nregression (frozen): ${rateTextEn(report.overall.regression)}\n`);
  process.stdout.write(`tuning examples:     ${rateTextEn(report.overall.tuning)}\n`);
  for (const a of report.axes) {
    if (a.regression.total + a.regression.not_run + a.tuning.total + a.tuning.not_run === 0) continue;
    process.stdout.write(`  ${a.axis.padEnd(22)} regression ${rateTextEn(a.regression)} · tuning ${rateTextEn(a.tuning)}\n`);
  }
  for (const b of report.blocked) process.stdout.write(`  not run: ${b.axis ?? 'all'} — ${b.reason_ar}\n`);
  process.stdout.write(`report: ${join(outDir, `${report.run_id}.md`)}\n`);

  // record in the server's database (the Control Center shows the latest report) — only when it already exists
  if (!argv.includes('--no-record')) {
    const dataDirArg = opt(argv, 'data-dir');
    const config = loadConfig({ ...process.env, ...(dataDirArg ? { MEDLEVO_DATA_DIR: fromInitCwd(dataDirArg) } : {}) }, { cwd: process.env.INIT_CWD ?? process.cwd() });
    if (existsSync(config.dbPath)) {
      const db = openDb(config.dbPath);
      try {
        migrate(db);
        syncCatalogue(db, Date.now());
        recordRun(db, report, Date.now());
        process.stdout.write(`recorded in ${config.dbPath} (Control Center → التقييم)\n`);
      } finally {
        db.close();
      }
    } else {
      process.stdout.write(`no server database at ${config.dbPath}: the run was not recorded (the files above are the report)\n`);
    }
  }

  let code = 0;
  if (comparePath) {
    const base = JSON.parse(readFileSync(fromInitCwd(comparePath), 'utf8')) as EvalReport;
    const cmp = compareReports(base, report);
    const file = join(outDir, `compare-${base.run_id}-${report.run_id}.md`);
    writeFileSync(file, renderCompareMarkdown(cmp));
    writeFileSync(file.replace(/\.md$/, '.json'), `${JSON.stringify(cmp, null, 2)}\n`);
    process.stdout.write(`compare: ${cmp.verdict} (${cmp.regressions.length} stopped passing, ${cmp.fixes.length} now pass) → ${file}\n`);
    if (cmp.verdict === 'regressions') code = 4;
    if (cmp.verdict === 'not_comparable') {
      // (review of track F5) a changed regression set or skipped regression cases must not pass a gate silently (CI)
      process.stdout.write(`  ${cmp.reason_ar}\n`);
      code = 6;
    }
  }
  if (code === 0 && argv.includes('--strict') && (report.overall.regression.failed > 0 || report.overall.regression.errors > 0)) code = 5;
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`MedLevo evaluation failed: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(1);
  });
