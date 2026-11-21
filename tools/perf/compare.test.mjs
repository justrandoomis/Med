// Self-test of the performance gate comparator (tools/perf/compare.mjs): `node --test tools/perf/compare.test.mjs`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collect, compare, loadAccepted, main, median, resolvePath, UsageError, validateBaseline } from './compare.mjs';

const baseline = (extra = {}) => ({
  provisional: false,
  threshold_pct: 10,
  metrics: {
    'lecture.job_ms': { file: 'lecture-300', path: 'processing_job_ms', unit: 'ms', better: 'lower', value: 1000 },
    'ink.ops_per_s': { file: 'learning-ink', path: 'push.cards.ops_per_s', unit: 'ops/s', better: 'higher', value: 1000 },
    ...extra,
  },
});

const runOf = (jobMs, opsPerS) => ({
  'lecture-300': { environment: { node: 'v22' }, results: { processing_job_ms: jobMs } },
  'learning-ink': { results: { push: { cards: { ops_per_s: opsPerS } } } },
});

const statusOf = (res, id) => res.rows.find((r) => r.metric === id).status;

describe('compare', () => {
  it('fails an 11 % regression (lower is better)', () => {
    const b = baseline();
    const res = compare(b, collect(b, [runOf(1110, 1000)]), { thresholdPct: 10 });
    assert.equal(statusOf(res, 'lecture.job_ms'), 'regression');
    assert.equal(res.rows.find((r) => r.metric === 'lecture.job_ms').change_pct, 11);
    assert.deepEqual(res.failed.map((r) => r.metric), ['lecture.job_ms']);
  });

  it('passes a 9 % regression', () => {
    const b = baseline();
    const res = compare(b, collect(b, [runOf(1090, 1000)]), { thresholdPct: 10 });
    assert.equal(statusOf(res, 'lecture.job_ms'), 'ok');
    assert.equal(res.failed.length, 0);
  });

  it('fails an 11 % drop of a higher-is-better metric and passes an improvement', () => {
    const b = baseline();
    const res = compare(b, collect(b, [runOf(500, 890)]), { thresholdPct: 10 });
    assert.equal(statusOf(res, 'ink.ops_per_s'), 'regression');
    assert.equal(statusOf(res, 'lecture.job_ms'), 'ok');
    assert.equal(res.rows.find((r) => r.metric === 'lecture.job_ms').change_pct, -50);
  });

  it('passes an accepted regression and carries its reason', () => {
    const b = baseline();
    const accepted = loadAccepted({ accepted: [{ metric: 'lecture.job_ms', reason: 'more modules at boot, accepted by the owner' }] });
    const res = compare(b, collect(b, [runOf(1500, 1000)]), { thresholdPct: 10, accepted });
    const row = res.rows.find((r) => r.metric === 'lecture.job_ms');
    assert.equal(row.status, 'accepted');
    assert.equal(row.reason, 'more modules at boot, accepted by the owner');
    assert.equal(res.failed.length, 0);
  });

  it('rejects an accepted regression without a reason', () => {
    assert.throws(() => loadAccepted({ accepted: [{ metric: 'lecture.job_ms', reason: ' ' }] }), UsageError);
  });

  it('reports a missing metric and fails on it', () => {
    const b = baseline();
    const run = runOf(1000, 1000);
    delete run['learning-ink'];
    const res = compare(b, collect(b, [run]), { thresholdPct: 10 });
    assert.equal(statusOf(res, 'ink.ops_per_s'), 'missing');
    assert.deepEqual(res.failed.map((r) => r.metric), ['ink.ops_per_s']);
  });

  it('never fails a change inside the absolute noise floor, nor a metric with no baseline value', () => {
    const b = baseline({
      'tiny.ms': { file: 'lecture-300', path: 'tiny_ms', unit: 'ms', better: 'lower', value: 1, floor: 0.5 },
      'new.ms': { file: 'lecture-300', path: 'processing_job_ms', unit: 'ms', better: 'lower', value: null },
    });
    const run = runOf(1000, 1000);
    run['lecture-300'].results.tiny_ms = 1.4; // +40 %, but 0.4 ms < floor
    const res = compare(b, collect(b, [run]), { thresholdPct: 10 });
    assert.equal(statusOf(res, 'tiny.ms'), 'ok');
    assert.equal(statusOf(res, 'new.ms'), 'no_baseline');
    assert.equal(res.failed.length, 0);
  });

  it('takes the median over runs', () => {
    const b = baseline();
    const c = collect(b, [runOf(1300, 1000), runOf(1000, 1000), runOf(1050, 1000)]);
    assert.equal(c['lecture.job_ms'].median, 1050);
    assert.deepEqual(c['lecture.job_ms'].values, [1300, 1000, 1050]);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
});

describe('paths', () => {
  it('resolves nested keys, non-ASCII keys and summed array selectors', () => {
    const r = { a: { 'القيمة التجريبية': { p50: 1.5 } }, jobs: [{ kind: 'x', ms: 10 }, { kind: 'y', ms: 5 }, { kind: 'x', ms: 2 }] };
    assert.equal(resolvePath(r, 'a.القيمة التجريبية.p50'), 1.5);
    assert.equal(resolvePath(r, 'jobs[kind=x].ms'), 12);
    assert.equal(resolvePath(r, 'jobs[kind=z].ms'), null);
    assert.equal(resolvePath(r, 'a.nope'), null);
  });

  it('validates the committed baseline', () => {
    const committed = JSON.parse(readFileSync(new URL('../../docs/perf/baseline.json', import.meta.url), 'utf8'));
    validateBaseline(committed);
    assert.ok(Object.keys(committed.metrics).length > 0);
    const acc = JSON.parse(readFileSync(new URL('../../docs/perf/accepted-regressions.json', import.meta.url), 'utf8'));
    loadAccepted(acc);
  });
});

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'medlevo-perf-compare-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (p, v) => writeFileSync(join(dir, p), JSON.stringify(v));
  const setup = (name, { provisional = false, jobMs = 1110 } = {}) => {
    const root = join(dir, name);
    mkdirSync(join(root, 'runs', 'server-1'), { recursive: true });
    for (const [file, v] of Object.entries(runOf(jobMs, 1000))) write(join(name, 'runs', 'server-1', `${file}.json`), v);
    write(join(name, 'baseline.json'), { ...baseline(), provisional });
    write(join(name, 'accepted.json'), { accepted: [] });
    return { root, args: ['--runs-root', join(root, 'runs'), '--baseline', join(root, 'baseline.json'), '--accepted', join(root, 'accepted.json')] };
  };
  const quiet = () => {};

  it('exits 1 on a regression, 0 when the baseline is provisional, 1 again with --strict', () => {
    assert.equal(main(setup('a').args, quiet), 1);
    const p = setup('b', { provisional: true });
    assert.equal(main(p.args, quiet), 0);
    assert.equal(main([...p.args, '--strict'], quiet), 1);
  });

  it('--record rewrites the values and clears provisional; the same runs then pass', () => {
    const s = setup('c', { provisional: true });
    const out = join(s.root, 'medians.json');
    assert.equal(main([...s.args, '--record', '--out', out], quiet), 0);
    const rec = JSON.parse(readFileSync(join(s.root, 'baseline.json'), 'utf8'));
    assert.equal(rec.provisional, false);
    assert.equal(rec.metrics['lecture.job_ms'].value, 1110);
    assert.equal(rec.metrics['lecture.job_ms'].path, 'processing_job_ms');
    assert.deepEqual(rec.environment, { node: 'v22' });
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).metrics['lecture.job_ms'].median, 1110);
    assert.equal(main(s.args, quiet), 0);
  });

  it('refuses a call without runs', () => {
    assert.throws(() => main(['--baseline', 'x.json'], quiet), UsageError);
  });
});
