#!/usr/bin/env node
// Performance gate comparator (PRD AOS-23.2): reads the JSON files the MEDLEVO_PERF suites write
// (apps/server/test/perf/* → <scenario>.json, e2e/perf.spec.ts → <project>.json), takes the median of every tracked
// metric over the runs given, and compares it with the committed baseline (docs/perf/baseline.json).
//
//   node tools/perf/compare.mjs --runs-root perf-results            # every sub-directory of perf-results is one run
//   node tools/perf/compare.mjs --run a --run b --run c             # or name the run directories
//     [--baseline docs/perf/baseline.json] [--accepted docs/perf/accepted-regressions.json]
//     [--threshold 10] [--out medians.json] [--summary summary.md] [--strict] [--record]
//
// The baseline is the metric list: each entry says which file and JSON path the number comes from, whether lower or
// higher is better, an optional absolute noise floor, and its value. A metric FAILS when it is worse than the baseline
// by more than --threshold % (default: the baseline's threshold_pct, else 10) AND by more than its floor — unless it is
// listed in the accepted-regressions file with a reason. A metric the baseline tracks but no run produced is MISSING
// and fails too (a renamed or dropped measurement must be noticed). A metric whose baseline value is null is reported
// but never fails (nothing recorded to compare with yet).
//
// A `provisional: true` baseline (numbers measured on other hardware) is compared and reported, but never fails the
// run unless --strict is given: re-record it from a CI run with --record, which rewrites the values (and environment)
// in the --baseline file from the medians of the runs given and sets provisional to false.
//
// Exit codes: 0 pass, 1 regression or missing metric, 2 usage / input error.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class UsageError extends Error {}

/** Parse a metric path: `a.b[kind=x].c` → [{key:'a'},{key:'b'},{match:{kind:'x'}},{key:'c'}]. */
export function parsePath(path) {
  const out = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[[^\]=]+=[^\]]*\])*)$/.exec(part);
    if (!m) throw new UsageError(`bad metric path segment «${part}» in «${path}»`);
    if (m[1]) out.push({ key: m[1] });
    for (const sel of m[2].matchAll(/\[([^\]=]+)=([^\]]*)\]/g)) out.push({ match: { field: sel[1], value: sel[2] } });
  }
  return out;
}

/**
 * Resolve a path inside a results object. An array selector `[field=value]` keeps the matching elements; when several
 * elements match, the numbers at the end of the path are summed (e.g. the time of every `extract_questions` job).
 */
export function resolvePath(obj, path) {
  let cur = [obj];
  for (const seg of parsePath(path)) {
    const next = [];
    for (const v of cur) {
      if (v === null || typeof v !== 'object') continue;
      if ('key' in seg) {
        if (seg.key in v) next.push(v[seg.key]);
      } else if (Array.isArray(v)) {
        for (const el of v) if (el && typeof el === 'object' && String(el[seg.match.field]) === seg.match.value) next.push(el);
      }
    }
    cur = next;
  }
  const nums = cur.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 1000) / 1000;
}

/** Load every `*.json` file of one run directory: { 'lecture-300': {environment, results}, … } keyed by basename. */
export function loadRun(dir) {
  const files = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      files[name.slice(0, -5)] = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (e) {
      throw new UsageError(`${join(dir, name)} is not valid JSON: ${e.message}`);
    }
  }
  return files;
}

/** Medians of every baseline metric over the runs: { id: { median, values } }. */
export function collect(baseline, runs) {
  const out = {};
  for (const [id, spec] of Object.entries(baseline.metrics)) {
    const values = [];
    for (const run of runs) {
      const file = run[spec.file];
      if (!file) continue;
      const v = resolvePath(file.results ?? file, spec.path);
      if (v !== null) values.push(v);
    }
    out[id] = { median: median(values), values };
  }
  return out;
}

export function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || !baseline.metrics || typeof baseline.metrics !== 'object') throw new UsageError('baseline has no "metrics" object');
  for (const [id, spec] of Object.entries(baseline.metrics)) {
    if (typeof spec.file !== 'string' || typeof spec.path !== 'string') throw new UsageError(`baseline metric ${id}: "file" and "path" are required`);
    if (spec.better !== 'lower' && spec.better !== 'higher') throw new UsageError(`baseline metric ${id}: "better" must be "lower" or "higher"`);
    if (spec.value !== null && typeof spec.value !== 'number') throw new UsageError(`baseline metric ${id}: "value" must be a number or null`);
    parsePath(spec.path);
  }
}

/** { metric id → reason }; every entry needs a non-empty reason. */
export function loadAccepted(json) {
  const map = new Map();
  for (const e of json?.accepted ?? []) {
    if (!e || typeof e.metric !== 'string') throw new UsageError('accepted-regressions: every entry needs "metric"');
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new UsageError(`accepted-regressions: ${e.metric} has no reason`);
    map.set(e.metric, e.reason.trim());
  }
  return map;
}

/**
 * Compare collected medians with the baseline. Status per metric: ok | regression | accepted | missing | no_baseline.
 * `change_pct` is signed so that a positive number is always «worse».
 */
export function compare(baseline, collected, { thresholdPct, accepted = new Map() }) {
  const rows = [];
  for (const [id, spec] of Object.entries(baseline.metrics)) {
    const cur = collected[id]?.median ?? null;
    const base = spec.value;
    const row = { metric: id, unit: spec.unit ?? '', better: spec.better, baseline: base, current: cur, runs: collected[id]?.values.length ?? 0, change_pct: null, status: 'ok' };
    if (cur === null) row.status = 'missing';
    else if (base === null) row.status = 'no_baseline';
    else {
      const worse = spec.better === 'lower' ? cur - base : base - cur;
      row.change_pct = base === 0 ? (worse > 0 ? Infinity : 0) : Math.round((worse / Math.abs(base)) * 1000) / 10;
      const beyondFloor = worse > (spec.floor ?? 0);
      if (beyondFloor && row.change_pct > thresholdPct) {
        row.status = accepted.has(id) ? 'accepted' : 'regression';
        if (accepted.has(id)) row.reason = accepted.get(id);
      }
    }
    rows.push(row);
  }
  const unknownAccepted = [...accepted.keys()].filter((id) => !(id in baseline.metrics));
  const failed = rows.filter((r) => r.status === 'regression' || r.status === 'missing');
  return { rows, failed, unknownAccepted };
}

/** Rewrite the baseline values from the collected medians (missing metrics keep null). */
export function record(baseline, collected, environment) {
  const metrics = {};
  for (const [id, spec] of Object.entries(baseline.metrics)) metrics[id] = { ...spec, value: collected[id]?.median ?? null };
  return { ...baseline, provisional: false, recorded_at: new Date().toISOString(), environment: environment ?? null, metrics };
}

const fmt = (n) => (n === null || n === undefined ? '—' : String(n));

export function table(rows) {
  const lines = ['| metric | baseline | current | worse by | runs | status |', '|---|---|---|---|---|---|'];
  for (const r of rows) {
    const change = r.change_pct === null ? '—' : `${r.change_pct > 0 ? '+' : ''}${r.change_pct} %`;
    const status = r.status === 'accepted' ? `accepted: ${r.reason}` : r.status;
    lines.push(`| ${r.metric} (${r.unit}, ${r.better} is better) | ${fmt(r.baseline)} | ${fmt(r.current)} | ${change} | ${r.runs} | ${status} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const a = { run: [], runsRoot: null, baseline: 'docs/perf/baseline.json', accepted: 'docs/perf/accepted-regressions.json', threshold: null, out: null, summary: null, strict: false, record: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      return v;
    };
    if (k === '--run') a.run.push(val());
    else if (k === '--runs-root') a.runsRoot = val();
    else if (k === '--baseline') a.baseline = val();
    else if (k === '--accepted') a.accepted = val();
    else if (k === '--threshold') a.threshold = Number(val());
    else if (k === '--out') a.out = val();
    else if (k === '--summary') a.summary = val();
    else if (k === '--strict') a.strict = true;
    else if (k === '--record') a.record = true;
    else throw new UsageError(`unknown argument ${k}`);
  }
  if (a.runsRoot) {
    for (const d of readdirSync(a.runsRoot).sort()) {
      const p = join(a.runsRoot, d);
      if (statSync(p).isDirectory() && readdirSync(p).some((f) => f.endsWith('.json'))) a.run.push(p);
    }
  }
  if (a.run.length === 0) throw new UsageError('no run directories (--run <dir> or --runs-root <dir>)');
  if (a.threshold !== null && !(a.threshold >= 0)) throw new UsageError('--threshold must be a number ≥ 0');
  return a;
}

export function main(argv, log = (s) => process.stdout.write(`${s}\n`)) {
  const args = parseArgs(argv);
  const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
  validateBaseline(baseline);
  const accepted = existsSync(args.accepted) ? loadAccepted(JSON.parse(readFileSync(args.accepted, 'utf8'))) : new Map();
  const runs = args.run.map((d) => loadRun(resolve(d)));
  const collected = collect(baseline, runs);
  const environment = runs.flatMap((r) => Object.values(r)).find((f) => f?.environment)?.environment ?? null;

  if (args.out) writeFileSync(args.out, JSON.stringify({ generated_at: new Date().toISOString(), runs: args.run, environment, metrics: collected }, null, 2));

  if (args.record) {
    const next = record(baseline, collected, environment);
    writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
    const missing = Object.entries(next.metrics).filter(([, m]) => m.value === null).map(([id]) => id);
    log(`[perf] baseline recorded to ${args.baseline} from ${args.run.length} run(s)${missing.length ? `; no value for: ${missing.join(', ')}` : ''}`);
    return 0;
  }

  const thresholdPct = args.threshold ?? baseline.threshold_pct ?? 10;
  const { rows, failed, unknownAccepted } = compare(baseline, collected, { thresholdPct, accepted });
  const provisional = baseline.provisional === true;
  const head = [
    `## Performance gate (AOS-23.2): ${args.run.length} run(s) vs ${args.baseline}, threshold ${thresholdPct} %`,
    provisional ? '\n**The baseline is provisional** (numbers measured on other hardware, not comparable): reported only. Re-record it from a CI run with `--record`.\n' : '',
  ].join('\n');
  const tail = [];
  if (failed.length) tail.push(`**${failed.length} failing:** ${failed.map((r) => `${r.metric} (${r.status}${r.change_pct !== null ? `, +${r.change_pct} %` : ''})`).join(', ')}`);
  if (unknownAccepted.length) tail.push(`Accepted-regression entries for metrics the baseline does not track: ${unknownAccepted.join(', ')}`);
  const text = `${head}\n${table(rows)}\n\n${tail.join('\n\n')}`;
  log(text);
  if (args.summary) appendFileSync(args.summary, `${text}\n`);
  if (failed.length === 0) return 0;
  return provisional && !args.strict ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`[perf] ${e instanceof UsageError ? '' : 'error: '}${e.message}\n`);
    process.exitCode = 2;
  }
}
