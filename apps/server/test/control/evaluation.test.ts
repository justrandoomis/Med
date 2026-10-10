// §57 evaluation (track F5): the EvaluationCase catalogue, per-axis rates WITH denominators (Wilson 95%), the
// regression set kept apart from tuning examples, the honest Markdown (never «100%» from a small sample), the
// compare-and-rollback comparison, the runner on the REAL pipeline (throwaway data dir, real uploads, real
// processing; AI axes through the evaluation-only scripted provider), failure / error / abstention paths, the store
// (catalogue upsert + retire, run retention), the Control Center routes and the `npm run eval` CLI itself.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_AXES, EVAL_SMALL_SAMPLE, type EvalCaseResult, type EvalReport, type EvaluationOverviewResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { CATALOGUE, CATALOGUE_VERSION, SOURCES, regressionHash, sourcesFor, type EvalCaseDef } from '../../src/modules/control/evaluation/catalogue';
import { compareReports, rateOf, rateTextAr, rateTextEn, renderCompareMarkdown, renderMarkdown, wilson95 } from '../../src/modules/control/evaluation/report';
import { runEvaluation, selectCases } from '../../src/modules/control/evaluation/runner';
import { RUNS_KEPT, evaluationOverview, recordRun, syncCatalogue } from '../../src/modules/control/evaluation/store';
import { createTestApp, type TestApp } from '../helpers/app';

const run = promisify(execFile);
const outcomes = (o: Array<EvalCaseResult['outcome']>) => o.map((outcome) => ({ outcome }));
const toJsonRows = (rows: unknown[]) => JSON.stringify(rows);

describe('rates with denominators (Wilson 95%) and honest wording', () => {
  it('the denominator is pass + fail + error; not_run is counted apart', () => {
    const r = rateOf(outcomes(['pass', 'pass', 'fail', 'error', 'not_run']));
    expect(r).toMatchObject({ passed: 2, total: 4, failed: 1, errors: 1, not_run: 1, rate: 0.5, small_sample: true });
    expect(r.ci95![0]).toBeLessThan(0.5);
    expect(r.ci95![1]).toBeGreaterThan(0.5);
    expect(rateOf([]).ci95).toBeNull();
  });

  it('Wilson bounds stay inside [0, 1] and are honest for 0 / n and n / n', () => {
    expect(wilson95(0, 10)![0]).toBe(0);
    expect(wilson95(10, 10)![1]).toBe(1);
    expect(wilson95(10, 10)![0]).toBeLessThan(0.8); // ten out of ten is NOT certainty
    expect(wilson95(29, 30)![0]).toBeGreaterThan(0.8);
    expect(wilson95(0, 0)).toBeNull();
  });

  it('a perfect small sample is never written as «100%» (Arabic and English, Markdown too)', () => {
    const perfect = rateOf(outcomes(new Array(12).fill('pass')));
    expect(perfect.small_sample).toBe(true);
    for (const s of [rateTextAr(perfect), rateTextEn(perfect)]) {
      expect(s).toContain('12');
      expect(s).not.toMatch(/100\s?%/);
    }
    expect(rateTextAr(perfect)).toContain('عينة صغيرة');
    // even a large sample whose upper bound rounds to 1.0 is capped below «100%»
    const big = rateOf(outcomes([...new Array(999).fill('pass'), 'fail']));
    expect(big.small_sample).toBe(false);
    expect(rateTextEn(big)).not.toMatch(/100\s?%/);
    const report = fakeReport('r1', [res('a', 'text_accuracy', 'regression', 'pass'), res('b', 'key_binding', 'tuning', 'pass')]);
    const md = renderMarkdown(report);
    expect(md).not.toMatch(/100\s?%/);
    expect(md).toContain('1/1 passed');
    expect(md).toContain('small sample');
    expect(md).toContain('not** a model');
  });
});

describe('the catalogue (EvaluationCase definitions)', () => {
  it('has unique ids, every axis, both sets, and only fixtures that exist', () => {
    const ids = CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const axis of EVAL_AXES) expect(CATALOGUE.some((c) => c.axis === axis), axis).toBe(true);
    expect(CATALOGUE.some((c) => c.set === 'regression')).toBe(true);
    expect(CATALOGUE.some((c) => c.set === 'tuning')).toBe(true);
    for (const s of Object.values(SOURCES)) expect(existsSync(join(REPO_ROOT, 'fixtures', s.file)), s.file).toBe(true);
    // the Golden Set the extractors were developed against is tuning; nothing of it is in the regression set
    for (const c of CATALOGUE.filter((x) => x.set === 'regression')) {
      const src = 'source' in c.check ? SOURCES[c.check.source].file : null;
      expect(src?.startsWith('golden/') ?? false, c.id).toBe(false);
    }
  });

  it('the regression hash changes when a regression expectation changes, not when a tuning one does', () => {
    const base = regressionHash(CATALOGUE);
    const reg = CATALOGUE.findIndex((c) => c.set === 'regression');
    const tun = CATALOGUE.findIndex((c) => c.set === 'tuning');
    const changedReg = CATALOGUE.map((c, i) => (i === reg ? { ...c, expected: { changed: true } } : c));
    const changedTun = CATALOGUE.map((c, i) => (i === tun ? { ...c, expected: { changed: true } } : c));
    expect(regressionHash(changedReg)).not.toBe(base);
    expect(regressionHash(changedTun)).toBe(base);
  });

  it('selects by set / axis / id prefix and uploads question sources before their lecture (AC-16 order)', () => {
    expect(selectCases({ set: 'regression' }).every((c) => c.set === 'regression')).toBe(true);
    expect(selectCases({ axes: ['key_binding'] }).every((c) => c.axis === 'key_binding')).toBe(true);
    expect(selectCases({ only: ['cite.'] }).map((c) => c.id)).toEqual(CATALOGUE.filter((c) => c.id.startsWith('cite.')).map((c) => c.id));
    const keys = sourcesFor(selectCases({ only: ['link.surgery.A1'] }));
    expect(keys).toEqual(['surgery_qs', 'appendicitis']);
  });
});

describe('compare-and-rollback: side-by-side runs', () => {
  it('lists cases that stopped passing, cases that now pass, and what changed in the system', () => {
    const base = fakeReport('base', [res('a', 'key_binding', 'regression', 'pass'), res('b', 'key_binding', 'regression', 'fail'), res('c', 'text_accuracy', 'tuning', 'pass')]);
    const head = fakeReport('head', [res('a', 'key_binding', 'regression', 'fail'), res('b', 'key_binding', 'regression', 'pass'), res('c', 'text_accuracy', 'tuning', 'pass')]);
    head.system.versions.index = 'chunk-v2';
    const c = compareReports(base, head);
    expect(c.verdict).toBe('regressions');
    expect(c.regressions.map((x) => x.case_id)).toEqual(['a']);
    expect(c.fixes.map((x) => x.case_id)).toEqual(['b']);
    expect(c.system_changes).toContainEqual({ key: 'index', base: 'chunk-v1', head: 'chunk-v2' });
    expect(renderCompareMarkdown(c)).toContain('index: chunk-v1 → chunk-v2');
    // only TUNING cases changed → no regression verdict
    const t2 = fakeReport('t2', [res('a', 'key_binding', 'regression', 'pass'), res('b', 'key_binding', 'regression', 'fail'), res('c', 'text_accuracy', 'tuning', 'fail')]);
    expect(compareReports(base, t2).verdict).toBe('no_regressions');
  });

  it('runs on different regression sets are not comparable (the hash differs)', () => {
    const base = fakeReport('base', [res('a', 'key_binding', 'regression', 'pass')]);
    const head = fakeReport('head', [res('a', 'key_binding', 'regression', 'fail')]);
    head.catalogue.regression_hash = 'other';
    const c = compareReports(base, head);
    expect(c).toMatchObject({ comparable: false, verdict: 'not_comparable' });
    expect(c.reason_ar).toContain('الكتالوج');
  });
});

describe('the runner on the real pipeline (throwaway data dir, scripted AI)', () => {
  let report: EvalReport;
  const logLines: string[] = [];
  beforeAll(async () => {
    report = await runEvaluation({
      log: (l) => logLines.push(l),
      only: ['cite.', 'support.', 'abstain.', 'overabstain.anchored', 'overabstain.retrieved_ct', 'key.surgery.A1', 'key.surgery.B3', 'link.surgery.A1', 'bidi.', 'image.caption.1', 'image.caption.3', 'text.appendicitis.no_reversed_lam_alef'],
      label: 'vitest subset',
    });
  }, 240_000);

  it('evaluates the selected cases and reports regression and tuning apart', () => {
    expect(report.cases.length).toBe(selectCases({ only: ['cite.', 'support.', 'abstain.', 'overabstain.anchored', 'overabstain.retrieved_ct', 'key.surgery.A1', 'key.surgery.B3', 'link.surgery.A1', 'bidi.', 'image.caption.1', 'image.caption.3', 'text.appendicitis.no_reversed_lam_alef'] }).length);
    const byId = new Map(report.cases.map((c) => [c.case_id, c]));
    for (const id of ['cite.valid_in_scope', 'cite.unknown_alias', 'cite.fabricated_id', 'cite.out_of_scope', 'cite.valid_plus_unknown']) expect(byId.get(id)?.outcome, id).toBe('pass');
    for (const id of ['support.restated', 'support.cross_language', 'support.changed_number', 'support.added_negation', 'support.changed_unit', 'support.topical_only']) expect(byId.get(id)?.outcome, id).toBe('pass');
    for (const id of ['abstain.out_of_scope', 'abstain.real_patient', 'abstain.fabricated_alias', 'abstain.unsupported_answer', 'overabstain.anchored', 'overabstain.retrieved_ct']) expect(byId.get(id)?.outcome, id).toBe('pass');
    for (const id of ['key.surgery.A1', 'key.surgery.B3', 'link.surgery.A1', 'image.caption.1', 'image.caption.3', 'text.appendicitis.no_reversed_lam_alef']) expect(byId.get(id)?.outcome, id).toBe('pass');
    expect(report.overall.regression.total).toBe(report.cases.filter((c) => c.set === 'regression').length);
    expect(report.overall.tuning.total).toBe(report.cases.filter((c) => c.set === 'tuning').length);
    expect(report.overall.regression.small_sample).toBe(report.overall.regression.total < EVAL_SMALL_SAMPLE);
    expect(report).toMatchObject({ mode: 'scripted', label: 'vitest subset', catalogue: { version: CATALOGUE_VERSION, regression_hash: regressionHash() } });
    expect(report.system.versions).toMatchObject({ pipeline: expect.any(String), index: expect.any(String), ai_rules: expect.any(String), claim_verifier: expect.any(String) });
    expect(report.system.models).toBeNull(); // scripted: no model is evaluated
    expect(report.notes_ar.join(' ')).toContain('لا جودة نموذج');
  });

  it('abstention is measured on the real path: an out-of-scope question abstains WITHOUT a generator call', () => {
    const c = report.cases.find((x) => x.case_id === 'abstain.out_of_scope')!;
    const observed = JSON.parse(c.observed) as { status: string; abstain: string; generator_calls: number };
    expect(observed).toMatchObject({ status: 'abstained', abstain: 'not_found_in_scope', generator_calls: 0 });
    const ok = JSON.parse(report.cases.find((x) => x.case_id === 'overabstain.anchored')!.observed) as { status: string; linked_claims: number };
    expect(ok.status).toBe('final');
    expect(ok.linked_claims).toBeGreaterThan(0);
  });

  it('the throwaway data directory is removed afterwards', () => {
    const line = logLines.find((l) => l.startsWith('removed the evaluation data directory '));
    expect(line).toBeTruthy();
    expect(existsSync(line!.replace('removed the evaluation data directory ', ''))).toBe(false);
  });
});

describe('failure, error and not-run paths are reported, never counted as passes', () => {
  it('a wrong expectation fails, a missing question fails, a generator call the case did not script fails with its reason', async () => {
    const base = CATALOGUE.find((c) => c.id === 'key.surgery.A1')!;
    const custom: EvalCaseDef[] = [
      { ...base, id: 'x.wrong_key', expected: { answer_status: 'source_key', key_labels: ['D'] } },
      { ...base, id: 'x.missing_question', check: { type: 'q_key', source: 'surgery_qs', section: 'Z', n: '99' } },
      { id: 'x.dir_wrong', axis: 'rtl_bidi', set: 'tuning', title_ar: 'اتجاه خاطئ عمدًا', check: { type: 'detect_dir', text: 'نص عربي' }, expected: 'ltr' },
      // an invalid request makes the evaluation itself fail (HTTP 400): an evaluation ERROR, never a pass or a fail
      { id: 'x.eval_error', axis: 'image_match', set: 'regression', title_ar: 'طلب غير صالح', check: { type: 'image_match', source: 'appendicitis', request: { modality: 'x'.repeat(5000) } as never }, expected: { accepted_figures: [] } },
      { id: 'x.chat_unscripted', axis: 'over_abstention', set: 'regression', title_ar: 'مولّد بلا نص مكتوب', check: { type: 'chat', question: 'Why is ultrasound first in children?', anchorNeedle: 'Ultrasound is the first-line', script: { kind: 'none' } }, expected: { supported_shown: true } },
    ];
    const r = await runEvaluation({ catalogue: custom });
    const o = Object.fromEntries(r.cases.map((c) => [c.case_id, c]));
    expect(o['x.wrong_key']!.outcome).toBe('fail');
    expect(o['x.wrong_key']!.observed).toContain('"key_labels":["B"]');
    expect(o['x.missing_question']!).toMatchObject({ outcome: 'fail', reason_ar: expect.stringContaining('لم يُستخرج') });
    expect(o['x.dir_wrong']!.outcome).toBe('fail');
    expect(o['x.eval_error']!).toMatchObject({ outcome: 'error', reason_ar: expect.stringContaining('خطأ أثناء التقييم') });
    expect(r.overall.regression.errors).toBe(1);
    // the generator was called with no script: nothing is shown as supported → over-abstention FAIL with the reason
    expect(o['x.chat_unscripted']!).toMatchObject({ outcome: 'fail', reason_ar: expect.stringContaining('استُدعي المولّد') });
    expect(o['x.chat_unscripted']!.observed).toContain('no script for task chat');
    expect(r.overall.regression.passed).toBe(0);
    expect(r.overall.tuning.passed).toBe(0);
  }, 240_000);

  it('live mode without a key: AI axes are not run, with the reason (never a pass)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await runEvaluation({ mode: 'live', only: ['support.restated', 'abstain.real_patient', 'bidi.dir.1'] });
      const o = Object.fromEntries(r.cases.map((c) => [c.case_id, c]));
      expect(o['support.restated']!.outcome).toBe('not_run');
      expect(o['abstain.real_patient']!.outcome).toBe('not_run');
      expect(o['support.restated']!.reason_ar).toContain('ANTHROPIC_API_KEY');
      expect(o['bidi.dir.1']!.outcome).toBe('pass'); // deterministic axes still run
      expect(r.blocked.map((b) => b.axis)).toEqual(expect.arrayContaining(['claim_support', 'abstention']));
      expect(r.overall.regression.not_run).toBe(2);
      expect(r.overall.regression.total).toBe(1);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  }, 240_000);
});

describe('the store and the Control Center routes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('the catalogue is mirrored into evaluation_case at start-up (who reviewed what), retired cases are kept', () => {
    const rows = t.ctx.db.all<{ id: string; set_kind: string; reviewed_by: string; origin: string; retired_at: number | null; fixture: string | null }>('SELECT id, set_kind, reviewed_by, origin, retired_at, fixture FROM evaluation_case');
    expect(rows.length).toBe(CATALOGUE.length);
    const a = rows.find((r) => r.id === 'key.surgery.A1')!;
    expect(a).toMatchObject({ set_kind: 'tuning', origin: 'catalogue:golden_set', retired_at: null, fixture: 'golden/questions_surgery_course1.pdf' });
    expect(a.reviewed_by).toContain('expected.json');
    expect(rows.find((r) => r.id === 'key.g4_merged.A1')!.origin).toBe('catalogue:acceptance_fixture');
    const r = syncCatalogue(t.ctx.db, t.ctx.clock.now(), CATALOGUE.filter((c) => c.id !== 'key.surgery.A1'));
    expect(r.retired).toBe(1);
    expect(t.ctx.db.get<{ retired_at: number | null }>('SELECT retired_at FROM evaluation_case WHERE id = ?', ['key.surgery.A1'])!.retired_at).not.toBeNull();
    syncCatalogue(t.ctx.db, t.ctx.clock.now());
    expect(t.ctx.db.get<{ retired_at: number | null }>('SELECT retired_at FROM evaluation_case WHERE id = ?', ['key.surgery.A1'])!.retired_at).toBeNull();
  });

  it('an unchanged catalogue writes nothing at the next boot (a restored database stays row-for-row identical, AC-30)', () => {
    const snapshot = () => toJsonRows(t.ctx.db.all('SELECT * FROM evaluation_case ORDER BY id'));
    const before = snapshot();
    const r = syncCatalogue(t.ctx.db, t.ctx.clock.now() + 86_400_000);
    expect(r).toEqual({ upserted: 0, retired: 0 });
    expect(snapshot()).toBe(before);
    // a changed case is written (and only that one)
    const changed = CATALOGUE.map((c) => (c.id === 'key.surgery.A1' ? { ...c, title_ar: `${c.title_ar} (معدّل)` } : c));
    expect(syncCatalogue(t.ctx.db, t.ctx.clock.now() + 2 * 86_400_000, changed).upserted).toBe(1);
    syncCatalogue(t.ctx.db, t.ctx.clock.now() + 3 * 86_400_000);
  });

  it('GET /api/control/evaluation without runs says how to run it; with runs it shows the latest and the comparison', async () => {
    const h = await t.login();
    const empty = (await t.app.inject({ method: 'GET', url: '/api/control/evaluation', headers: h })).json() as EvaluationOverviewResponse;
    expect(empty.latest).toBeNull();
    expect(empty.how_to_run_ar).toContain('npm run eval');
    expect(empty.catalogue.cases).toBe(CATALOGUE.length);
    expect(empty.catalogue.by_axis.key_binding.regression).toBeGreaterThan(0);

    const r1 = fakeReport('eval-1', [res('a', 'key_binding', 'regression', 'pass')]);
    const r2 = fakeReport('eval-2', [res('a', 'key_binding', 'regression', 'fail')]);
    r2.started_at = r1.started_at + 1000;
    recordRun(t.ctx.db, r1, t.ctx.clock.now());
    recordRun(t.ctx.db, r2, t.ctx.clock.now());
    const ov = (await t.app.inject({ method: 'GET', url: '/api/control/evaluation', headers: h })).json() as EvaluationOverviewResponse;
    expect(ov.latest?.run_id).toBe('eval-2');
    expect(ov.runs.map((x) => x.id)).toEqual(['eval-2', 'eval-1']);
    expect(ov.compare_with_previous).toMatchObject({ verdict: 'regressions', regressions: [{ case_id: 'a' }] });

    const one = await t.app.inject({ method: 'GET', url: '/api/control/evaluation/runs/eval-1', headers: h });
    expect(one.json().report.run_id).toBe('eval-1');
    const md = await t.app.inject({ method: 'GET', url: '/api/control/evaluation/runs/eval-1/report.md', headers: h });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain('attachment');
    expect(md.body).toContain('# MedLevo evaluation report — eval-1');
    expect((await t.app.inject({ method: 'GET', url: '/api/control/evaluation/runs/nope', headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/control/evaluation/runs/..%2Fx', headers: h })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/control/evaluation' })).statusCode).toBe(401);
  });

  it(`keeps the ${RUNS_KEPT} newest runs`, () => {
    for (let i = 0; i < RUNS_KEPT + 5; i++) {
      const r = fakeReport(`bulk-${String(i).padStart(3, '0')}`, [res('a', 'key_binding', 'regression', 'pass')]);
      r.started_at = 2_000_000_000_000 + i;
      recordRun(t.ctx.db, r, t.ctx.clock.now());
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM evaluation_run')!.n).toBe(RUNS_KEPT);
    expect(evaluationOverview(t.ctx.db).latest?.run_id).toBe(`bulk-${String(RUNS_KEPT + 4).padStart(3, '0')}`);
  });
});

describe('`npm run eval` (the CLI itself)', () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'medlevo-eval-out-'));
  });
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('writes JSON + Markdown, records nothing with --no-record, and --compare exits 4 on a regression', async () => {
    const cli = join(REPO_ROOT, 'apps', 'server', 'src', 'cli', 'eval.ts');
    const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const env = { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning', MEDLEVO_DATA_DIR: join(out, 'no-server-here') };
    const r = await run(tsx, [cli, '--only=bidi.dir,image.caption', '--no-record', `--out=${out}`, '--label=cli test'], { cwd: REPO_ROOT, env, timeout: 120_000 });
    expect(r.stdout).toContain('regression (frozen):');
    const latest = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')) as EvalReport;
    expect(latest.label).toBe('cli test');
    expect(latest.cases.every((c) => c.outcome === 'pass')).toBe(true);
    expect(readFileSync(join(out, 'latest.md'), 'utf8')).toContain('## Per axis');
    expect(existsSync(join(out, 'no-server-here'))).toBe(false);

    // compare: a baseline that claims every case passed. Today the real retrieval misses the «pregnancy test» question
    // (a measured over-abstention, docs/EVALUATION.md) → exit 4 with the comparison written; if retrieval is fixed the
    // same command exits 0 — either way the exit code follows the comparison, never a hard-coded verdict.
    const head = await run(tsx, [cli, '--only=overabstain.pregnancy_test,bidi.dir.1', '--no-record', `--out=${out}`], { cwd: REPO_ROOT, env, timeout: 120_000 });
    expect(head.stdout).toContain('report:');
    const headReport = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')) as EvalReport;
    const baseline = { ...headReport, run_id: 'baseline-x', cases: headReport.cases.map((c) => ({ ...c, outcome: 'pass' as const })) };
    writeFileSync(join(out, 'baseline.json'), JSON.stringify(baseline));
    const code = await run(tsx, [cli, '--only=overabstain.pregnancy_test,bidi.dir.1', '--no-record', `--out=${out}`, `--compare=${join(out, 'baseline.json')}`], { cwd: REPO_ROOT, env, timeout: 120_000 }).then(
      () => 0,
      (e: { code?: number }) => e.code ?? -1,
    );
    const now = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')) as EvalReport;
    const stillFails = now.cases.find((c) => c.case_id === 'overabstain.pregnancy_test')!.outcome !== 'pass';
    expect(code).toBe(stillFails ? 4 : 0);
    const cmp = readdirSync(out).find((f) => f.startsWith('compare-baseline-x-') && f.endsWith('.md'))!;
    expect(readFileSync(join(out, cmp), 'utf8')).toContain(stillFails ? 'Verdict: **regressions**' : 'Verdict: **no_regressions**');
  }, 240_000);
});

// ───────── helpers ─────────
function res(id: string, axis: EvalCaseResult['axis'], set: EvalCaseResult['set'], outcome: EvalCaseResult['outcome']): EvalCaseResult {
  return { case_id: id, axis, set, title_ar: id, fixture: null, outcome, expected: 'x', observed: 'y', reason_ar: outcome === 'pass' ? null : 'سبب', ms: 1 };
}

function fakeReport(id: string, cases: EvalCaseResult[]): EvalReport {
  const reg = cases.filter((c) => c.set === 'regression');
  const tun = cases.filter((c) => c.set === 'tuning');
  return {
    format: 'medlevo-eval-1',
    run_id: id,
    label: null,
    mode: 'scripted',
    set_filter: 'all',
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_001_000,
    catalogue: { version: CATALOGUE_VERSION, regression_hash: 'h', cases: cases.length, regression: reg.length, tuning: tun.length },
    system: { app_version: '0.1.0', git_commit: null, node: 'v22', versions: { index: 'chunk-v1', pipeline: 'process-v1' }, models: null },
    overall: { regression: rateOf(reg), tuning: rateOf(tun) },
    axes: EVAL_AXES.map((axis) => ({ axis, label_ar: axis, kind: 'deterministic', regression: rateOf(reg.filter((c) => c.axis === axis)), tuning: rateOf(tun.filter((c) => c.axis === axis)) })),
    cases,
    blocked: [],
    notes_ar: [],
  };
}
